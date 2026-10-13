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

/**
 * `tailscale serve --bg --https=<httpsPort> http://127.0.0.1:<port>`. The
 * HTTPS port is the local port unless named: the Inbox publishes on a stable
 * 8443 in front of whatever loopback port it has this run.
 */
export function buildServeArgs(port: number, httpsPort: number = port): string[] {
  return ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`];
}

/** `tailscale serve --https=<port> off` — the matching teardown. */
export function buildServeOffArgs(port: number): string[] {
  return ["serve", `--https=${port}`, "off"];
}

export type ServeStatusPortCheck = "free" | "conflict" | "malformed";

/**
 * Inspect `tailscale serve status --json` for an existing route on the given
 * port. Both the top-level background config (`TCP`) and every foreground
 * session (`Foreground.<sessionId>.TCP`) count: Tailscale prefers foreground
 * handlers, so a foreground mapping would silently shadow a background one we
 * install and route our advertised URL to someone else's service.
 *
 * Fails CLOSED: output we cannot recognize returns "malformed" so the caller
 * errors clearly instead of assuming the port is free.
 */
export function checkServeStatusPort(stdout: string, port: number): ServeStatusPortCheck {
  const trimmed = stdout.trim();
  if (trimmed === "") return "malformed";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "malformed";
  }
  // `null` is Tailscale's honest "no serve config"; `{}` likewise.
  if (parsed === null) return "free";
  if (typeof parsed !== "object" || Array.isArray(parsed)) return "malformed";

  const key = String(port);
  const checkTcp = (tcp: unknown): ServeStatusPortCheck => {
    if (tcp === undefined || tcp === null) return "free";
    if (typeof tcp !== "object" || Array.isArray(tcp)) return "malformed";
    return Object.prototype.hasOwnProperty.call(tcp, key) ? "conflict" : "free";
  };

  const top = checkTcp((parsed as { TCP?: unknown }).TCP);
  if (top !== "free") return top;

  const foreground = (parsed as { Foreground?: unknown }).Foreground;
  if (foreground === undefined || foreground === null) return "free";
  if (typeof foreground !== "object" || Array.isArray(foreground)) return "malformed";
  for (const session of Object.values(foreground)) {
    if (session === null) continue;
    if (typeof session !== "object" || Array.isArray(session)) return "malformed";
    const result = checkTcp((session as { TCP?: unknown }).TCP);
    if (result !== "free") return result;
  }
  return "free";
}

/**
 * Where an existing serve mapping on `port` sends its root handler, so a
 * caller can tell its own mapping (a loopback port it used before) from
 * someone else's. `free` when no mapping holds the port, `malformed` when the
 * output is not recognizable, else the mapping's `/` proxy target ("" when it
 * has none, such as a TCP forward or a file server). Read like
 * checkServeStatusPort: background and foreground configs both count.
 */
export function serveStatusProxy(stdout: string, port: number): { state: "free" } | { state: "malformed" } | { state: "mapped"; proxy: string } {
  const check = checkServeStatusPort(stdout, port);
  if (check !== "conflict") return { state: check };
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const configs = [parsed, ...Object.values((parsed.Foreground as Record<string, unknown> | undefined) ?? {})];
  for (const config of configs) {
    const web = (config as { Web?: unknown } | null)?.Web;
    if (!web || typeof web !== "object") continue;
    for (const [hostPort, entry] of Object.entries(web as Record<string, unknown>)) {
      if (!hostPort.endsWith(`:${port}`)) continue;
      const proxy = (entry as { Handlers?: Record<string, { Proxy?: unknown }> } | null)?.Handlers?.["/"]?.Proxy;
      return { state: "mapped", proxy: typeof proxy === "string" ? proxy : "" };
    }
  }
  return { state: "mapped", proxy: "" };
}

/**
 * Every serve route in `tailscale serve status --json`, background and
 * foreground: each web handler's proxy target (`Web["host:port"].Handlers`,
 * every path) and each raw TCP forward (`TCP[port].TCPForward`). Undefined
 * when the output is not recognizable.
 */
export function serveStatusRoutes(stdout: string): { port: number; target: string }[] | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null) return [];
  if (typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const routes: { port: number; target: string }[] = [];
  const foreground = (parsed as { Foreground?: unknown }).Foreground;
  const configs = [parsed, ...(foreground && typeof foreground === "object" ? Object.values(foreground as Record<string, unknown>) : [])];
  for (const config of configs) {
    if (!config || typeof config !== "object") continue;
    const tcp = (config as { TCP?: unknown }).TCP;
    if (tcp && typeof tcp === "object") {
      for (const [port, entry] of Object.entries(tcp as Record<string, unknown>)) {
        const forward = (entry as { TCPForward?: unknown } | null)?.TCPForward;
        if (typeof forward === "string" && /^\d+$/.test(port)) routes.push({ port: Number(port), target: `tcp://${forward}` });
      }
    }
    const web = (config as { Web?: unknown }).Web;
    if (web && typeof web === "object") {
      for (const [hostPort, entry] of Object.entries(web as Record<string, unknown>)) {
        const port = /:(\d+)$/.exec(hostPort)?.[1];
        const handlers = (entry as { Handlers?: unknown } | null)?.Handlers;
        if (!port || !handlers || typeof handlers !== "object") continue;
        for (const handler of Object.values(handlers as Record<string, unknown>)) {
          const proxy = (handler as { Proxy?: unknown } | null)?.Proxy;
          if (typeof proxy === "string") routes.push({ port: Number(port), target: proxy });
        }
      }
    }
  }
  return routes;
}

/**
 * A serve target that lands on `port` on this machine's loopback:
 * `http://127.0.0.1:<port>`, `http://localhost:<port>/x`, `https+insecure://…`,
 * or a TCP forward `tcp://127.0.0.1:<port>`.
 */
export function serveTargetIsLoopbackPort(target: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(target.replace(/^https\+insecure:/, "https:"));
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  return loopback && url.port !== "" && Number(url.port) === port;
}

/**
 * First https URL in `tailscale serve --bg` output whose port matches the
 * port we asked to publish, sans trailing slash. Serve output is
 * version-dependent, so an https URL for a DIFFERENT port (some other
 * pre-existing mapping echoed in the config dump) must not be advertised.
 */
export function extractServeHttpsUrl(output: string, expectedPort: number): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s|]+/g)) {
    const candidate = match[0].replace(/\/+$/, "");
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" || !url.hostname) continue;
      if (Number(url.port || "443") !== expectedPort) continue;
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Who owns this machine on the tailnet, as `tailscale status --json` reports it. */
export interface TailscaleSelfIdentity {
  /** The owning user's login (`User[Self.UserID].LoginName`); null for a tagged machine or when Tailscale does not say. */
  login: string | null;
  /** The machine carries ACL tags: it has no owning user, and serve sends no identity for tagged peers. */
  tagged: boolean;
}

/**
 * The login that owns this machine: `Self.UserID` looked up in the `User`
 * map (keyed by the id as a string). A tagged machine (`Self.Tags`
 * non-empty) is owned by its tags, not a person, so its login is null even
 * though Tailscale lists a "tagged-devices" pseudo-user for it. Undefined
 * when the output is not a status document.
 */
export function parseTailscaleSelfIdentity(stdout: string): TailscaleSelfIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const self = (parsed as { Self?: unknown }).Self;
  if (!self || typeof self !== "object" || Array.isArray(self)) return undefined;
  const tags = (self as { Tags?: unknown }).Tags;
  if (Array.isArray(tags) && tags.length > 0) return { login: null, tagged: true };
  const userId = (self as { UserID?: unknown }).UserID;
  const users = (parsed as { User?: unknown }).User;
  if ((typeof userId !== "number" && typeof userId !== "string") || !users || typeof users !== "object") {
    return { login: null, tagged: false };
  }
  const profile = (users as Record<string, unknown>)[String(userId)];
  const login = (profile as { LoginName?: unknown } | null | undefined)?.LoginName;
  return { login: typeof login === "string" && login.trim() !== "" ? login.trim() : null, tagged: false };
}

/**
 * A `Tailscale-User-*` header value as serve writes it: ASCII as is, anything
 * else RFC 2047 Q-encoded (`=?utf-8?q?J=C3=BCrgen?=`, Go's
 * `mime.QEncoding.Encode`, as one or more encoded words separated by
 * whitespace, which RFC 2047 drops between adjacent words). Returns the
 * decoded text, or null when an encoded word is malformed or not UTF-8:
 * never a guess, since the caller compares it to a login.
 */
export function decodeTailscaleHeaderValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.includes("=?")) return trimmed;
  let out = "";
  for (const word of trimmed.split(/\s+/)) {
    const match = /^=\?utf-8\?q\?([^?]*)\?=$/i.exec(word);
    if (!match) return null;
    const text = match[1]!;
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "_") {
        bytes.push(0x20);
      } else if (ch === "=") {
        const hex = text.slice(i + 1, i + 3);
        if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        const code = ch.charCodeAt(0);
        if (code > 0x7e || code < 0x21) return null;
        bytes.push(code);
      }
    }
    try {
      out += new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
      return null;
    }
  }
  // Serve encodes only non-ASCII values; an all-ASCII encoded word is not
  // what serve writes, so it is compared as it came, never as a login.
  return /^[\x00-\x7f]*$/.test(out) ? trimmed : out;
}

/**
 * urlHost "auto": resolve this machine's tailnet host once per process.
 * Detection is display-only like every urlHost value; callers gate on
 * remote-session state before resolving, so a local session never spawns the
 * tailscale CLI. A failed detection warns once and resolves undefined
 * (callers advertise localhost); a display setting must never break a server
 * launch. Shared by the Bun runtime and the Pi mirror (vendored copy), each
 * process holding its own cache.
 */
let autoHostResolution: { host: string | undefined } | undefined;

export function resolveAutoHostCached(
  detect: (run?: TailscaleRunner) => TailnetHostDetection = detectTailnetHost,
): string | undefined {
  if (!autoHostResolution) {
    const result = detect();
    if ("host" in result) {
      autoHostResolution = { host: result.host };
    } else {
      autoHostResolution = { host: undefined };
      process.stderr.write(
        `[plannotator] Warning: advertised URL host "auto" could not resolve a tailnet host — ${result.error} Advertising localhost.\n`,
      );
    }
  }
  return autoHostResolution.host;
}
