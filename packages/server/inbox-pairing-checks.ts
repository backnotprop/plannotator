/**
 * Plannotator Inbox: what this computer can tell about the two ways a phone
 * reaches it, for step 1 of "Pair a phone" (design of record
 * `.product/approved/inbox-settings-tabs/`, DESIGN.md section 4.2).
 *
 * `GET /api/inbox/pairing/checks` reads these and turns nothing on. Every
 * answer is advisory: the window shows a failing check with its fix, and the
 * only gate on the pairing code is a way being switched on (the owner's
 * no-loop rule). Nothing here reads the tailnet's other devices (dropped by
 * the owner, decision 4): `tailscale status` runs with `--peers=false`, and
 * the phone side is stated, never guessed.
 *
 * Every probe is asynchronous (child processes, each with its own time limit
 * that kills its whole process group, `runQuietly`), and the whole read has a
 * deadline, so a slow or hung `tailscale` never holds the Inbox's event loop
 * or the read: MCP waits, connection polls and the relay socket keep running
 * while the checks are read. The caller shares one read in flight and keeps
 * its answer a few seconds (inbox-devices.ts).
 *
 * Each probe is a seam (`PairingProbes`, and the Tailscale runner), so tests
 * never run the real `tailscale`, `openssl` or system tools against real
 * state.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  parseTailscaleSelfIdentity,
  serveStatusProxy,
  TAILSCALE_CLI_TIMEOUT_MS,
  TAILSCALE_SERVE_TIMEOUT_MS,
  type TailscaleRunResult,
} from "@plannotator/shared/tailscale";
import { inboxTlsDir, lanAddress } from "./inbox-lan";

/** The macOS application firewall: off, on (macOS asks per app), or blocking every incoming connection. Unknown elsewhere. */
export type FirewallState = "off" | "on" | "block_all" | "unknown";

/**
 * `cli_missing`: no `tailscale` command on PATH (Tailscale may still be
 * installed, as the Mac App Store app is without its command-line tool).
 * `no_answer`: the command did not answer within its time limit.
 */
export type TailscaleBackend = "running" | "stopped" | "signed_out" | "needs_approval" | "starting" | "cli_missing" | "no_answer" | "unknown";

export interface PairingChecks {
  wifi: {
    /** The private address the QR would carry (the same pick as the listener's), or null with no network. */
    address: string | null;
    /** The Wi-Fi network's name when the system tells it (macOS may hide it without Location permission). */
    network: string | null;
    /** `openssl` is on PATH, so the certificate can be made. */
    openssl: boolean;
    /** The certificate already exists (made by an earlier Turn on), so `openssl` is no longer needed. */
    certificate: boolean;
    /** `dns-sd` (macOS) or `avahi-publish` (Linux) exists: phones nearby list this computer by name. */
    bonjour: boolean;
    firewall: FirewallState;
  };
  tailscale: {
    state: TailscaleBackend;
    /** The login that owns this computer on the tailnet. */
    login: string | null;
    /** HTTPS certificates are on for the tailnet (`CertDomains`), which `tailscale serve --https` needs. Null when unknown. */
    https_certs: boolean | null;
    /** Port 8443 is free, or already the Inbox's own mapping. Null when unknown (not running, or serve did not answer). */
    port_free: boolean | null;
    /** What the CLI said when it could not be read, in its own words. */
    error: string | null;
  };
}

/** The probes the checks run. Every one is replaceable (tests), and none writes anything. */
export interface PairingProbes {
  lanAddress: () => string | null;
  /** The Wi-Fi network's name for the interface holding `address`, or null. */
  network: (address: string | null) => string | null | Promise<string | null>;
  /** The path of a command on PATH, or null. */
  which: (command: string) => string | null;
  firewall: () => FirewallState | Promise<FirewallState>;
}

/** How the checks run `tailscale`: a sync seam (tests' scripted runners) or the async default. */
export type PairingTailscaleRunner = (args: string[], timeoutMs: number) => TailscaleRunResult | Promise<TailscaleRunResult>;

const PROBE_TIMEOUT_MS = 2_000;
const SOCKETFILTERFW = "/usr/libexec/ApplicationFirewall/socketfilterfw";

/**
 * A child process run without a shell, its output read, with a hard time
 * limit. `ENOENT` / `ETIMEDOUT` as error codes.
 *
 * The limit holds even when the command is a shell wrapper that runs its
 * real program as a child without `exec` (the Mac app's
 * `/usr/local/bin/tailscale` is one): such a grandchild keeps the pipes open
 * after the wrapper dies. So the child starts in a process group of its own
 * (`detached`), and at the limit the whole group is killed, the pipes are
 * let go, and the answer settles at once, never waiting for the pipes to
 * close. Settling on exit alone would not hold either, for the same reason:
 * `close` waits for the pipes, so only the timer ends a lingering read.
 */
export function runQuietly(command: string, args: string[], timeoutMs: number): Promise<TailscaleRunResult> {
  const path = command.includes("/") ? (existsSync(command) ? command : null) : Bun.which(command);
  if (!path) return Promise.resolve({ error: Object.assign(new Error(`${command}: not found on PATH`), { code: "ENOENT" }), status: null, stdout: "", stderr: "" });
  const group = process.platform !== "win32";
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: TailscaleRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"], detached: group, windowsHide: true });
    } catch (cause) {
      finish({ error: cause instanceof Error ? cause : new Error(String(cause)), status: null, stdout: "", stderr: "" });
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish({ error, status: null, stdout, stderr }));
    child.on("close", (status) => finish({ status, stdout, stderr }));
    timer = setTimeout(() => {
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ error: Object.assign(new Error(`${command} did not answer in time`), { code: "ETIMEDOUT" }), status: null, stdout, stderr });
    }, timeoutMs);
  });
}

/**
 * `value`, or `fallback` once `ms` have passed: no probe (a seam that never
 * answers included) can hold a read of the checks past its deadline.
 */
function withDeadline<T>(value: T | Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(value).then(
      (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** The most one read of the checks takes: past it, a probe that has not answered reads as not answering. */
export const PAIRING_CHECKS_DEADLINE_MS = 15_000;

/** The default Tailscale runner for the checks: the CLI on PATH, asynchronously. */
export const runTailscaleQuietly: PairingTailscaleRunner = (args, timeoutMs) => runQuietly("tailscale", args, timeoutMs);

/**
 * `socketfilterfw --getglobalstate` and `--getblockall`, as macOS prints them
 * ("Firewall is enabled. (State = 1)", "Firewall has block all state set to
 * enabled." or the older "Block all DISABLED!"). Anything else is unknown.
 */
export function parseFirewallState(globalState: string, blockAll: string): FirewallState {
  const global = globalState.toLowerCase();
  if (/disabled|state = 0/.test(global)) return "off";
  if (!/enabled|state = [12]/.test(global)) return "unknown";
  const block = blockAll.toLowerCase();
  if (/disabled/.test(block)) return "on";
  if (/enabled|block all/.test(block) || /state = 2/.test(global)) return "block_all";
  return "on";
}

/** The `SSID : <name>` line of `ipconfig getsummary <iface>`; null when absent or redacted. */
export function parseIpconfigSsid(summary: string): string | null {
  const match = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(summary);
  const name = match?.[1] ?? "";
  if (!name || /^<redacted>$/i.test(name)) return null;
  return name;
}

/**
 * `tailscale status --json`'s `BackendState`, plus the owner's login and
 * whether HTTPS certificates are on (`CertDomains`). An answer that is not
 * a status document is `unknown`.
 */
export function parseTailscaleBackend(stdout: string): { state: TailscaleBackend; login: string | null; https_certs: boolean | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: "unknown", login: null, https_certs: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unknown", login: null, https_certs: null };
  const backend = (parsed as { BackendState?: unknown }).BackendState;
  const state: TailscaleBackend =
    backend === "Running"
      ? "running"
      : backend === "Stopped"
        ? "stopped"
        : backend === "NeedsLogin" || backend === "NoState"
          ? "signed_out"
          : backend === "NeedsMachineAuth"
            ? "needs_approval"
            : backend === "Starting"
              ? "starting"
              : "unknown";
  const certs = (parsed as { CertDomains?: unknown }).CertDomains;
  const login = state === "running" ? (parseTailscaleSelfIdentity(stdout)?.login ?? null) : null;
  return { state, login, https_certs: state === "running" ? Array.isArray(certs) && certs.length > 0 : null };
}

/** The interface that holds `address` (en0 for the Wi-Fi on most Macs). */
function interfaceOf(address: string): string | null {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if ((entries ?? []).some((entry) => entry.address === address)) return name;
  }
  return null;
}

async function stdoutOf(command: string, args: string[]): Promise<string | null> {
  const result = await runQuietly(command, args, PROBE_TIMEOUT_MS);
  return !result.error && result.status === 0 ? result.stdout : null;
}

export const defaultPairingProbes: PairingProbes = {
  lanAddress,
  network: async (address) => {
    if (!address) return null;
    if (process.platform === "darwin") {
      const iface = interfaceOf(address);
      if (!iface) return null;
      const summary = await stdoutOf("/usr/sbin/ipconfig", ["getsummary", iface]);
      return summary ? parseIpconfigSsid(summary) : null;
    }
    if (process.platform === "linux") {
      const name = (await stdoutOf("iwgetid", ["-r"]))?.trim();
      return name || null;
    }
    return null;
  },
  which: (command) => Bun.which(command),
  firewall: async () => {
    if (process.platform !== "darwin" || !existsSync(SOCKETFILTERFW)) return "unknown";
    const [global, blockAll] = await Promise.all([stdoutOf(SOCKETFILTERFW, ["--getglobalstate"]), stdoutOf(SOCKETFILTERFW, ["--getblockall"])]);
    if (global === null) return "unknown";
    return parseFirewallState(global, blockAll ?? "");
  },
};

export interface PairingChecksContext {
  dataDir: string;
  tailscale: PairingTailscaleRunner;
  /** The HTTPS port phones reach the tailnet door on (8443). */
  httpsPort: number;
  /** Proxy targets a mapping of the Inbox's own points at (its door listener now or last run). */
  ownTargets: () => string[];
  probes?: Partial<PairingProbes>;
  /** The whole read's deadline. Default `PAIRING_CHECKS_DEADLINE_MS`. */
  deadlineMs?: number;
}

async function tailscaleChecks(context: PairingChecksContext): Promise<PairingChecks["tailscale"]> {
  const tailscale: PairingChecks["tailscale"] = { state: "unknown", login: null, https_certs: null, port_free: null, error: null };
  // `--peers=false`: this computer only; the tailnet's other devices are never read.
  const status = await context.tailscale(["status", "--json", "--peers=false"], TAILSCALE_CLI_TIMEOUT_MS);
  if (status.error) {
    const code = (status.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") tailscale.state = "cli_missing";
    else if (code === "ETIMEDOUT") tailscale.state = "no_answer";
    else tailscale.error = status.error.message;
    return tailscale;
  }
  const parsed = parseTailscaleBackend(status.stdout);
  Object.assign(tailscale, parsed);
  if (parsed.state === "unknown") {
    const said = `${status.stderr}\n${status.stdout}`.trim();
    // The daemon is not running: the CLI cannot reach it and says so.
    if (/failed to connect|is tailscale(d)? running|not running|connection refused/i.test(said)) tailscale.state = "stopped";
    else tailscale.error = said.split("\n")[0] || null;
  }
  if (tailscale.state === "running") {
    const serve = await context.tailscale(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
    if (!serve.error && serve.status === 0) {
      const mapped = serveStatusProxy(serve.stdout, context.httpsPort);
      if (mapped.state === "free") tailscale.port_free = true;
      else if (mapped.state === "mapped") tailscale.port_free = context.ownTargets().includes(mapped.proxy);
    }
  }
  return tailscale;
}

/** Read every check once, the probes side by side. Turns nothing on, makes no certificate, publishes nothing. */
export async function readPairingChecks(context: PairingChecksContext): Promise<PairingChecks> {
  const probes = { ...defaultPairingProbes, ...context.probes };
  const address = probes.lanAddress();
  const bonjourTool = process.platform === "darwin" ? "dns-sd" : "avahi-publish";
  const tls = inboxTlsDir(context.dataDir);
  const deadline = context.deadlineMs ?? PAIRING_CHECKS_DEADLINE_MS;
  const silent: PairingChecks["tailscale"] = { state: "no_answer", login: null, https_certs: null, port_free: null, error: null };
  const [network, firewall, tailscale] = await Promise.all([
    address ? withDeadline(probes.network(address), deadline, null) : null,
    withDeadline(probes.firewall(), deadline, "unknown" as FirewallState),
    withDeadline(tailscaleChecks(context), deadline, silent),
  ]);
  return {
    wifi: {
      address,
      network,
      openssl: probes.which("openssl") !== null,
      certificate: existsSync(join(tls, "cert.pem")) && existsSync(join(tls, "key.pem")),
      bonjour: probes.which(bonjourTool) !== null,
      firewall,
    },
    tailscale,
  };
}
