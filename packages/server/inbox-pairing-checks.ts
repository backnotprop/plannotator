import { childEnv, childPath } from "@plannotator/shared/child-env";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  checkTailscaleAppAnswer,
  parseTailscaleSelfIdentity,
  tailscaleAppEnv,
  tailscaleAppFallback,
  TAILSCALE_CLI_TIMEOUT_MS,
  TAILSCALE_SERVE_TIMEOUT_MS,
  type TailscaleRunResult,
} from "@plannotator/shared/tailscale";
import { inboxTlsDir, lanAddress } from "./inbox-lan";
import type { TailnetDoorPort } from "./inbox-tailnet-door";

export type FirewallState = "off" | "on" | "block_all" | "unknown";

export type TailscaleBackend = "running" | "stopped" | "signed_out" | "needs_approval" | "starting" | "cli_missing" | "no_answer" | "unknown";

export interface PairingChecks {
  wifi: {
    address: string | null;
    network: string | null;
    openssl: boolean;
    certificate: boolean;
    bonjour: boolean;
    firewall: FirewallState;
  };
  tailscale: {
    state: TailscaleBackend;
    login: string | null;
    https_certs: boolean | null;
    port_free: boolean | null;
    https_port: number | null;
    error: string | null;
  };
}

export interface PairingProbes {
  lanAddress: () => string | null;
  network: (address: string | null) => string | null | Promise<string | null>;
  which: (command: string) => string | null;
  firewall: () => FirewallState | Promise<FirewallState>;
}

export type PairingTailscaleRunner = (args: string[], timeoutMs: number) => TailscaleRunResult | Promise<TailscaleRunResult>;

const PROBE_TIMEOUT_MS = 2_000;
const SOCKETFILTERFW = "/usr/libexec/ApplicationFirewall/socketfilterfw";

/** Runs without a shell. The child gets its own process group and the whole group is killed at the limit: a shell wrapper's grandchild keeps the pipes open after the wrapper dies, so only the timer ends a lingering read. */
export function runQuietly(command: string, args: string[], timeoutMs: number, env?: Record<string, string | undefined>): Promise<TailscaleRunResult> {
  const path = command.includes("/") ? (existsSync(command) ? command : null) : Bun.which(command, { PATH: childPath() });
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
      child = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"], detached: group, windowsHide: true, ...(env ? { env } : {}) });
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

export const PAIRING_CHECKS_DEADLINE_MS = 15_000;

export const runTailscaleQuietly: PairingTailscaleRunner = async (args, timeoutMs) => {
  const onPath = await runQuietly("tailscale", args, timeoutMs);
  const app = tailscaleAppFallback(onPath);
  return app ? checkTailscaleAppAnswer(await runQuietly(app, args, timeoutMs, tailscaleAppEnv(childEnv()))) : onPath;
};

export function parseFirewallState(globalState: string, blockAll: string): FirewallState {
  const global = globalState.toLowerCase();
  if (/disabled|state = 0/.test(global)) return "off";
  if (!/enabled|state = [12]/.test(global)) return "unknown";
  const block = blockAll.toLowerCase();
  if (/disabled/.test(block)) return "on";
  if (/enabled|block all/.test(block) || /state = 2/.test(global)) return "block_all";
  return "on";
}

export function parseIpconfigSsid(summary: string): string | null {
  const match = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(summary);
  const name = match?.[1] ?? "";
  if (!name || /^<redacted>$/i.test(name)) return null;
  return name;
}

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
  which: (command) => Bun.which(command, { PATH: childPath() }),
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
  doorPort: (serveStatus: string) => TailnetDoorPort;
  probes?: Partial<PairingProbes>;
  deadlineMs?: number;
}

async function tailscaleChecks(context: PairingChecksContext): Promise<PairingChecks["tailscale"]> {
  const tailscale: PairingChecks["tailscale"] = { state: "unknown", login: null, https_certs: null, port_free: null, https_port: null, error: null };
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
      const port = context.doorPort(serve.stdout);
      if (port.state === "usable") {
        tailscale.port_free = true;
        tailscale.https_port = port.port;
      } else if (port.state === "held") {
        tailscale.port_free = false;
        tailscale.https_port = port.port;
      } else if (port.state === "taken") tailscale.port_free = false;
    }
  }
  return tailscale;
}

export async function readPairingChecks(context: PairingChecksContext): Promise<PairingChecks> {
  const probes = { ...defaultPairingProbes, ...context.probes };
  const address = probes.lanAddress();
  const bonjourTool = process.platform === "darwin" ? "dns-sd" : "avahi-publish";
  const tls = inboxTlsDir(context.dataDir);
  const deadline = context.deadlineMs ?? PAIRING_CHECKS_DEADLINE_MS;
  const silent: PairingChecks["tailscale"] = { state: "no_answer", login: null, https_certs: null, port_free: null, https_port: null, error: null };
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
