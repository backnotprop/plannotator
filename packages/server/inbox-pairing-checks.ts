/**
 * Plannotator Inbox: what this computer can tell about the two ways a phone
 * reaches it, for step 1 of "Pair a phone" (design of record
 * `.product/approved/inbox-settings-tabs/`, DESIGN.md section 4.2).
 *
 * `GET /api/inbox/pairing/checks` reads these and turns nothing on. Every
 * answer is advisory: the window shows a failing check with its fix, and the
 * only gate on the pairing code is a way being switched on (the owner's
 * no-loop rule). Nothing here reads the tailnet's other devices (dropped by
 * the owner, decision 4): the phone side is stated, never guessed.
 *
 * Each probe is a seam (`PairingProbes`), so tests never run the real
 * `tailscale`, `openssl` or system tools against real state.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  parseTailscaleSelfIdentity,
  serveStatusProxy,
  TAILSCALE_CLI_TIMEOUT_MS,
  TAILSCALE_SERVE_TIMEOUT_MS,
  type TailscaleRunner,
} from "@plannotator/shared/tailscale";
import { inboxTlsDir, lanAddress } from "./inbox-lan";

/** The macOS application firewall: off, on (macOS asks per app), or blocking every incoming connection. */
export type FirewallState = "off" | "on" | "block_all" | "unknown";

export type TailscaleBackend = "running" | "stopped" | "signed_out" | "needs_approval" | "starting" | "not_installed" | "unknown";

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
  network: (address: string | null) => string | null;
  /** The path of a command on PATH, or null. */
  which: (command: string) => string | null;
  firewall: () => FirewallState;
}

const PROBE_TIMEOUT_MS = 2_000;
const SOCKETFILTERFW = "/usr/libexec/ApplicationFirewall/socketfilterfw";

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

function run(command: string, args: string[]): string | null {
  try {
    const out = spawnSync(command, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    return out.status === 0 ? (out.stdout ?? "") : null;
  } catch {
    return null;
  }
}

/** The interface that holds `address` (en0 for the Wi-Fi on most Macs). */
function interfaceOf(address: string): string | null {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if ((entries ?? []).some((entry) => entry.address === address)) return name;
  }
  return null;
}

export const defaultPairingProbes: PairingProbes = {
  lanAddress,
  network: (address) => {
    if (!address) return null;
    if (process.platform === "darwin") {
      const iface = interfaceOf(address);
      if (!iface) return null;
      const summary = run("/usr/sbin/ipconfig", ["getsummary", iface]);
      return summary ? parseIpconfigSsid(summary) : null;
    }
    if (process.platform === "linux") {
      const iwgetid = Bun.which("iwgetid");
      const name = iwgetid ? run(iwgetid, ["-r"])?.trim() : "";
      return name || null;
    }
    return null;
  },
  which: (command) => Bun.which(command),
  firewall: () => {
    if (process.platform !== "darwin" || !existsSync(SOCKETFILTERFW)) return "unknown";
    const global = run(SOCKETFILTERFW, ["--getglobalstate"]);
    if (global === null) return "unknown";
    return parseFirewallState(global, run(SOCKETFILTERFW, ["--getblockall"]) ?? "");
  },
};

export interface PairingChecksContext {
  dataDir: string;
  tailscale: TailscaleRunner;
  /** The HTTPS port phones reach the tailnet door on (8443). */
  httpsPort: number;
  /** Proxy targets a mapping of the Inbox's own points at (its door listener now or last run). */
  ownTargets: () => string[];
  probes?: Partial<PairingProbes>;
}

/** Read every check once. Turns nothing on, makes no certificate, publishes nothing. */
export function readPairingChecks(context: PairingChecksContext): PairingChecks {
  const probes = { ...defaultPairingProbes, ...context.probes };
  const address = probes.lanAddress();
  const bonjourTool = process.platform === "darwin" ? "dns-sd" : "avahi-publish";
  const wifi: PairingChecks["wifi"] = {
    address,
    network: address ? probes.network(address) : null,
    openssl: probes.which("openssl") !== null,
    certificate: existsSync(join(inboxTlsDir(context.dataDir), "cert.pem")) && existsSync(join(inboxTlsDir(context.dataDir), "key.pem")),
    bonjour: probes.which(bonjourTool) !== null,
    firewall: probes.firewall(),
  };

  const tailscale: PairingChecks["tailscale"] = { state: "unknown", login: null, https_certs: null, port_free: null, error: null };
  const status = context.tailscale(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
  if (status.error) {
    const code = (status.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") tailscale.state = "not_installed";
    else tailscale.error = status.error.message;
  } else {
    const parsed = parseTailscaleBackend(status.stdout);
    Object.assign(tailscale, parsed);
    if (parsed.state === "unknown") {
      const said = `${status.stderr}\n${status.stdout}`.trim();
      // The daemon is not running: the CLI cannot reach it and says so.
      if (/failed to connect|is tailscale(d)? running|not running|connection refused/i.test(said)) tailscale.state = "stopped";
      else tailscale.error = said.split("\n")[0] || null;
    }
  }
  if (tailscale.state === "running") {
    const serve = context.tailscale(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
    if (!serve.error && serve.status === 0) {
      const mapped = serveStatusProxy(serve.stdout, context.httpsPort);
      if (mapped.state === "free") tailscale.port_free = true;
      else if (mapped.state === "mapped") tailscale.port_free = context.ownTargets().includes(mapped.proxy);
    }
  }
  return { wifi, tailscale };
}
