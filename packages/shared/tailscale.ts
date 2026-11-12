import { childEnv } from "./child-env";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isValidUrlHost } from "./config";

export const TAILSCALE_CLI_TIMEOUT_MS = 3_000;
export const TAILSCALE_SERVE_TIMEOUT_MS = 10_000;

export function isAutoUrlHost(host: string): boolean {
  return host.toLowerCase() === "auto";
}

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

export const MAC_TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface TailscaleAppLookup {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
}

export function tailscaleAppFallback(result: TailscaleRunResult, lookup: TailscaleAppLookup = {}): string | undefined {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return undefined;
  if ((lookup.env ?? process.env).PLANNOTATOR_TEST_SANDBOX) return undefined;
  if ((lookup.platform ?? process.platform) !== "darwin") return undefined;
  return (lookup.exists ?? existsSync)(MAC_TAILSCALE_APP_CLI) ? MAC_TAILSCALE_APP_CLI : undefined;
}

export function tailscaleAppEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return env.SHLVL ? env : { ...env, SHLVL: "1" };
}

const APP_GUI_FAILED = /The Tailscale GUI failed to start/;

export const TAILSCALE_APP_NOT_CLI =
  "The Tailscale app did not answer as a command-line tool; turn on Tailscale → Settings → Install CLI, then try again.";

export function checkTailscaleAppAnswer(result: TailscaleRunResult): TailscaleRunResult {
  if (result.error || !APP_GUI_FAILED.test(`${result.stdout}\n${result.stderr}`)) return result;
  return { ...result, error: new Error(TAILSCALE_APP_NOT_CLI) };
}

export type TailscaleSpawn = (command: string, args: string[], timeoutMs: number, env: Record<string, string | undefined>) => TailscaleRunResult;

const spawnTailscale: TailscaleSpawn = (command, args, timeoutMs, env) => {
  const result = spawnSync(command, args, {
    env,
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

export function createTailscaleRunner(
  spawn: TailscaleSpawn = spawnTailscale,
  lookup: TailscaleAppLookup = {},
  baseEnv: () => Record<string, string | undefined> = childEnv,
): TailscaleRunner {
  return (args, timeoutMs) => {
    const onPath = spawn("tailscale", args, timeoutMs, baseEnv());
    const app = tailscaleAppFallback(onPath, lookup);
    return app ? checkTailscaleAppAnswer(spawn(app, args, timeoutMs, tailscaleAppEnv(baseEnv()))) : onPath;
  };
}

export const runTailscale: TailscaleRunner = createTailscaleRunner();

export function explainTailscaleSetup(result: TailscaleRunResult): string | undefined {
  const output = `${result.stdout}\n${result.stderr}`;
  const links = output.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  if (APP_GUI_FAILED.test(output)) return TAILSCALE_APP_NOT_CLI;
  const enableLink = links.find((link) => /\/f\/(?:serve|https)\b/.test(link));
  if (enableLink || /\b(?:serve|https)\b[^\n]*\bnot enabled\b/i.test(output)) {
    const link = enableLink ?? links.find((candidate) => /login\.tailscale\.com/.test(candidate));
    return (
      "Tailscale Serve is off for your tailnet. That is a one-time Tailscale setting, not a Plannotator bug.\n" +
      (link
        ? `Open ${link} and press Enable HTTPS (keep "HTTPS certificates" ticked; Funnel is not needed), then try again.`
        : "Turn on HTTPS certificates in the Tailscale admin console (https://login.tailscale.com/admin/dns), then try again.")
    );
  }
  if (/\bLogged out\b/.test(output)) {
    const login = /Log in at:\s*(https:\/\/\S+)/.exec(output)?.[1];
    return `Tailscale is signed out on this computer. Sign in ${login ? `at ${login}` : "with `tailscale up` or the Tailscale app"}, then try again.`;
  }
  if (/Tailscale is stopped/.test(output)) {
    return "Tailscale is turned off on this computer. Turn it on with `tailscale up` or the Tailscale app, then try again.";
  }
  if (/not yet approved/i.test(output)) {
    return "This computer is waiting for approval in the Tailscale admin console (Machines). Approve it, then try again.";
  }
  if (/Failed to connect to local Tailscale|not running\?|tailscaled\.service not running/i.test(output)) {
    return "Tailscale is not running on this computer. Open the Tailscale app (or start tailscaled), then try again.";
  }
  return undefined;
}

export function describeTailscaleFailure(result: TailscaleRunResult): string {
  const explained = explainTailscaleSetup(result);
  if (explained) return explained;
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "`tailscale` CLI not found on PATH (on a Mac, Plannotator also looks for the app at /Applications/Tailscale.app). With the Tailscale app, turn on its command-line tool (Tailscale → Settings → Install CLI); otherwise install Tailscale from https://tailscale.com/download and sign in.";
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

export function buildServeArgs(port: number, httpsPort: number = port): string[] {
  return ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`];
}

export function buildServeOffArgs(port: number): string[] {
  return ["serve", `--https=${port}`, "off"];
}

export type ServeStatusPortCheck = "free" | "conflict" | "malformed";

export function checkServeStatusPort(stdout: string, port: number): ServeStatusPortCheck {
  const trimmed = stdout.trim();
  if (trimmed === "") return "malformed";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "malformed";
  }
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

export interface TailscaleSelfIdentity {
  login: string | null;
  tagged: boolean;
}

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
  return /^[\x00-\x7f]*$/.test(out) ? trimmed : out;
}

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
