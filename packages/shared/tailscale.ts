/**
 * Tailscale helpers for remote-friendly sessions.
 *
 * Two consumers:
 *   - urlHost "auto" (PLANNOTATOR_URL_HOST=auto): detect this machine's
 *     tailnet host so remote sessions advertise a reachable URL without the
 *     user hand-copying their MagicDNS name into config. Display-only, like
 *     every urlHost value — binding stays governed by PLANNOTATOR_REMOTE.
 *   - `--tailscale` (Bun CLI): parse/compose the `tailscale serve` commands
 *     that publish a loopback-bound session over the tailnet with HTTPS.
 *
 * Pure parsers live here so both runtimes (Bun server, Pi extension) share
 * them. The only process-spawning edge is `runTailscale`, which never invokes
 * a shell and is injectable for tests.
 */

import { spawnSync } from "node:child_process";
import { isValidUrlHost } from "./config";

/** Detection commands answer from local state; keep the wait short. */
export const TAILSCALE_CLI_TIMEOUT_MS = 3_000;
/** Serve config writes talk to the daemon; allow a little more. */
export const TAILSCALE_SERVE_TIMEOUT_MS = 10_000;

/** The urlHost sentinel that requests tailnet host detection. */
export function isAutoUrlHost(host: string): boolean {
  return host.toLowerCase() === "auto";
}

/**
 * Extract this machine's MagicDNS name from `tailscale status --json` output.
 * Tailscale reports it FQDN-style with a trailing dot ("host.tail1234.ts.net.").
 */
export function parseTailscaleStatusDnsName(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const dnsName = (parsed as { Self?: { DNSName?: unknown } } | null)?.Self?.DNSName;
  if (typeof dnsName !== "string") return undefined;
  const host = dnsName.trim().replace(/\.+$/, "");
  return host !== "" && isValidUrlHost(host) ? host : undefined;
}

/** Strict CGNAT (100.64.0.0/10) IPv4 — the only range Tailscale assigns. */
export function parseTailscaleIpv4(value: string): string | undefined {
  const parts = value.trim().split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  ) {
    return undefined;
  }
  const octets = parts.map(Number);
  if (octets[0] !== 100 || octets[1]! < 64 || octets[1]! > 127) return undefined;
  return octets.join(".");
}

/** `tailscale ip -4` output must contain exactly one valid tailnet address. */
export function parseTailscaleIpv4Output(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== 1) return undefined;
  return parseTailscaleIpv4(lines[0]!);
}

export interface TailscaleRunResult {
  error?: Error;
  status: number | null;
  stdout: string;
  stderr: string;
}

export type TailscaleRunner = (args: string[], timeoutMs: number) => TailscaleRunResult;

/** Run the `tailscale` CLI without a shell. */
export const runTailscale: TailscaleRunner = (args, timeoutMs) => {
  const result = spawnSync("tailscale", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    error: result.error ?? undefined,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/** Turn a failed CLI invocation into one actionable sentence. */
export function describeTailscaleFailure(result: TailscaleRunResult): string {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "`tailscale` CLI not found on PATH. Install Tailscale (https://tailscale.com/download) and sign in with `tailscale up`.";
    }
    if (code === "ETIMEDOUT") {
      return "Timed out waiting for the `tailscale` CLI.";
    }
    return result.error.message;
  }
  const detail = result.stderr.trim();
  return `Tailscale is unavailable or not signed in.${detail ? ` ${detail}` : " Run `tailscale up` and retry."}`;
}

export type TailnetHostDetection = { host: string } | { error: string };

/**
 * Detect this machine's advertised tailnet host: MagicDNS name first
 * (`tailscale status --json` → `Self.DNSName`), single CGNAT IPv4 fallback
 * (`tailscale ip -4`). Never throws — callers surface `{ error }` as a
 * warning and fall back to localhost.
 */
export function detectTailnetHost(run: TailscaleRunner = runTailscale): TailnetHostDetection {
  const status = run(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
  if (status.error || status.status !== 0) {
    return { error: describeTailscaleFailure(status) };
  }
  const dnsName = parseTailscaleStatusDnsName(status.stdout);
  if (dnsName) return { host: dnsName };
  const ip = run(["ip", "-4"], TAILSCALE_CLI_TIMEOUT_MS);
  if (!ip.error && ip.status === 0) {
    const address = parseTailscaleIpv4Output(ip.stdout);
    if (address) return { host: address };
  }
  return {
    error: "Tailscale did not report a MagicDNS name or a single 100.64.0.0/10 IPv4 address.",
  };
}

/** `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` */
export function buildServeArgs(port: number): string[] {
  return ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`];
}

/** `tailscale serve --https=<port> off` — the matching teardown. */
export function buildServeOffArgs(port: number): string[] {
  return ["serve", `--https=${port}`, "off"];
}

/**
 * True when `tailscale serve status --json` already routes the given port —
 * a pre-existing mapping we must not steal or tear down.
 */
export function serveStatusHasPort(stdout: string, port: number): boolean {
  const trimmed = stdout.trim();
  if (trimmed === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const tcp = (parsed as { TCP?: unknown } | null)?.TCP;
  if (!tcp || typeof tcp !== "object") return false;
  return Object.prototype.hasOwnProperty.call(tcp, String(port));
}

/** First https URL in `tailscale serve --bg` output, sans trailing slash. */
export function extractServeHttpsUrl(output: string): string | undefined {
  const match = output.match(/https:\/\/[^\s|]+/);
  if (!match) return undefined;
  const candidate = match[0].replace(/\/+$/, "");
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}
