/**
 * PROTOTYPE (branch proto/inbox-fixed-address, not for merge): a fixed
 * address for the Plannotator Inbox, `http://inbox.plannotator.localhost`,
 * through portless (https://github.com/vercel-labs/portless, pinned 0.15.8)
 * in its plain-HTTP mode. Research and findings:
 * .product/drafts/portless-local-url/ (BRIEF.md and one-click/README.md).
 *
 * Plain HTTP on purpose: the proxy answers this computer only, and
 * `http://*.localhost` is a secure context in Chromium, Firefox and WebKit
 * (notifications work), so there is no certificate to make, trust or warn
 * about. portless's `service install --no-tls` never touches its CA
 * (`installService` calls `prepareTrust` only when `useHttps`).
 *
 * What "Sure" does, in order (`enable`):
 *  1. Find Node 24+ (portless needs it). None: the offer is never shown.
 *  2. Look at port 80 (`readProxyState`). Another program there, or a
 *     portless HTTPS proxy Plannotator did not install: stop, say why,
 *     change nothing, ask for nothing.
 *  3. Install portless into `<data dir>/portless/` with that Node's own npm,
 *     as the person, never globally. Skipped when it is already there.
 *  4. Skipped when a plain-HTTP portless already answers on 80. Otherwise the
 *     ONE privileged step, `portless service install --no-tls --port 80`:
 *     the proxy on 80 at boot. It also keeps `127.0.0.1
 *     inbox.plannotator.localhost` in /etc/hosts (portless's default, for
 *     resolvers that do not map `*.localhost` themselves). When Plannotator's
 *     own earlier HTTPS service is installed, the same elevated command runs
 *     `service uninstall` first, so one prompt replaces it. The OS asks for
 *     the password itself: macOS `osascript … with administrator
 *     privileges`, Linux `pkexec`, Windows `Start-Process -Verb RunAs`. The
 *     command line is built from fixed words and validated paths only
 *     (`privilegedInstallCommand`); nothing a request carries reaches it.
 *  5. As the person (never root, so `~/.portless` stays theirs):
 *     `portless alias inbox.plannotator <name listener port>`. Never
 *     `--force` (it kills the caller's process group), always detached.
 *  6. Verify: `http://inbox.plannotator.localhost/api/inbox/health` (or
 *     127.0.0.1:80 with the name as Host, when this process cannot resolve
 *     the name) answers THIS Inbox's `serverSession`.
 *
 * The name listener: a second loopback listener (the "Over your tailnet"
 * pattern) that portless points at, so the window's own port keeps refusing
 * every forwarded request (`X-Forwarded-For` -> 403 local_only). It hands a
 * request to the window's handler only when Host is the name, every
 * `X-Forwarded-For` hop is loopback, no `Tailscale-*` header is present, and
 * the path is not an agent or connection route (`checkNameRequest`).
 *
 * The fallback is always `http://localhost:<port>`: nothing an agent or
 * connection uses changes, and a failure leaves the Inbox exactly as it was.
 *
 * The wait after the password (measured 2026-10-16 on the owner's Mac): the
 * plist was written 1-2 s after the prompt, and the proxy started exactly 10 s
 * later. portless's macOS install runs `launchctl bootstrap` (RunAtLoad starts
 * the proxy at once) and then `launchctl kickstart -k`, which kills that new
 * instance; launchd then holds the respawn for its ThrottleInterval (10 s) and
 * `kickstart` blocks until it ends. A temp LaunchAgent reproduces it as the
 * person: `kickstart -k` right after `bootstrap` takes 10.02 s, plain
 * `kickstart` 0.007 s. So the elevated macOS command puts a `launchctl` shim
 * first on PATH (a root-owned mktemp folder, made and removed inside the same
 * command) that drops the `-k` from `kickstart -k`; everything else passes
 * through to /bin/launchctl. And so the window never says "waiting for your
 * password" after it was typed, the elevated command's first act makes a
 * marker folder (`accepted-<nonce>`, in a folder the person owns, made before
 * the prompt): the server polls for it and moves `step` from `password` to
 * `installing`, then `starting` (the proxy, the alias) and `verifying`.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";

/** The name portless registers; it adds `.localhost`. */
export const INBOX_NAME_LABEL = "inbox.plannotator";
export const INBOX_NAME_HOST = "inbox.plannotator.localhost";
export const INBOX_NAME_URL = `http://${INBOX_NAME_HOST}/`;
/** The port the plain-HTTP proxy listens on (portless's default with --no-tls). */
export const INBOX_NAME_PROXY_PORT = 80;
/** The portless release this prototype was read against (BRIEF.md). */
export const PORTLESS_VERSION = "0.15.8";
export const PORTLESS_MIN_NODE_MAJOR = 24;
/** The password prompt's reason line (macOS only shows it; the title says "osascript"). */
export const INBOX_NAME_PROMPT =
  "Plannotator wants to give the Inbox a fixed address, inbox.plannotator.localhost. This starts a small local proxy (portless) on this computer only.";

const NAME_FILE = "name.json";
/** The folder (under the Inbox's own folder, the person's) where the elevated command leaves its marker. */
const SETUP_DIR = "name-setup";
/** How often the server looks for the marker and for the proxy while setup runs. */
const SETUP_POLL_MS = 250;
const PRIVILEGED_TIMEOUT_MS = 5 * 60_000;
const NPM_TIMEOUT_MS = 3 * 60_000;
const ALIAS_TIMEOUT_MS = 20_000;

// ── Pure rules (unit-tested) ────────────────────────────────────────────────

/** A literal loopback address as a socket or `X-Forwarded-For` names it. */
export function isLoopbackAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  let ip = value.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  const parts = ip.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Paths that never answer through the name: an agent's surface, not a browser's. */
const AGENT_PATHS = [/^\/mcp(\/|$)/, /^\/api\/inbox\/control\//, /^\/api\/inbox\/bridge\//, /^\/api\/inbox\/device(\/|$)/];

export type NameRequestCheck = { ok: true } | { ok: false; status: number; code: string; error: string };

/**
 * Whether the name listener hands a request to the window. `peer` is the
 * socket's remote address (always loopback: the listener binds 127.0.0.1;
 * checked anyway). portless always adds `X-Forwarded-For` with the browser's
 * address; in portless's LAN mode that would be a Wi-Fi address, refused.
 */
export function checkNameRequest(headers: Headers, path: string, peer: string | null, host: string = INBOX_NAME_HOST): NameRequestCheck {
  if (peer !== null && !isLoopbackAddress(peer)) return { ok: false, status: 403, code: "local_only", error: "The fixed address answers only this computer." };
  const rawHost = (headers.get("host") ?? "").trim().toLowerCase();
  const named = rawHost === host || rawHost === `${host}:${INBOX_NAME_PROXY_PORT}`;
  if (!named) return { ok: false, status: 403, code: "forbidden_host", error: `This listener answers only ${host}.` };
  for (const name of headers.keys()) {
    if (name.toLowerCase().startsWith("tailscale-")) return { ok: false, status: 403, code: "local_only", error: "The fixed address answers only this computer." };
  }
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const hops = forwarded.split(",").map((hop) => hop.trim());
    if (hops.length === 0 || hops.some((hop) => !isLoopbackAddress(hop))) {
      return { ok: false, status: 403, code: "local_only", error: "The fixed address answers only this computer." };
    }
  }
  if (AGENT_PATHS.some((pattern) => pattern.test(path))) {
    return { ok: false, status: 403, code: "local_only", error: "Agents reach the Inbox at http://localhost:<port>, never through the fixed address." };
  }
  return { ok: true };
}

/** `v24.15.0` -> 24. */
export function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)\.\d+\.\d+/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

const POSIX_PATH = /^\/[A-Za-z0-9 ._+@,:\/-]*$/;
const WINDOWS_PATH = /^[A-Za-z]:\\[A-Za-z0-9 ._+@,()~\\-]*$/;
const USER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const NUMERIC_ID = /^\d{1,10}$/;

/** Throws unless `value` is a path that needs no escaping beyond single quotes (POSIX) or double quotes (Windows). */
export function assertSafePath(value: string, platform: NodeJS.Platform): string {
  const rule = platform === "win32" ? WINDOWS_PATH : POSIX_PATH;
  if (!rule.test(value) || value.includes("..")) throw new Error(`Refusing an unusual path in a privileged command: ${JSON.stringify(value)}`);
  return value;
}

export interface PrivilegedContext {
  /** Absolute, real path of Node 24+. */
  node: string;
  /** portless's `dist/cli.js`. */
  cli: string;
  /** PORTLESS_STATE_DIR: `~/.portless`, owned by the person. */
  stateDir: string;
  /** The person (osascript and pkexec do not set SUDO_USER; portless reads it to give its files back). */
  user: string;
  uid: string;
  gid: string;
  home: string;
}

/** How the privileged step asks: the OS prompt (default), `sudo -n` (CI), or as-is (an elevated CI runner). */
export type ElevationMode = "prompt" | "sudo" | "direct";

export interface CommandLine {
  command: string;
  args: string[];
}

/** POSIX `env` words handing portless the person's identity, state dir, plain HTTP and /etc/hosts sync. */
function posixEnvWords(ctx: PrivilegedContext): string[] {
  return [
    `SUDO_USER=${ctx.user}`,
    `SUDO_UID=${ctx.uid}`,
    `SUDO_GID=${ctx.gid}`,
    `HOME=${ctx.home}`,
    `PORTLESS_STATE_DIR=${ctx.stateDir}`,
    "PORTLESS_HTTPS=0",
    // portless's default, said out loud so it is baked into the service: the root proxy keeps
    // `127.0.0.1 inbox.plannotator.localhost` in /etc/hosts, for Safari wherever the system resolver does not map *.localhost itself.
    "PORTLESS_SYNC_HOSTS=1",
  ];
}

function validate(ctx: PrivilegedContext, platform: NodeJS.Platform): void {
  assertSafePath(ctx.node, platform);
  assertSafePath(ctx.cli, platform);
  assertSafePath(ctx.stateDir, platform);
  if (platform !== "win32") {
    assertSafePath(ctx.home, platform);
    if (!USER_NAME.test(ctx.user)) throw new Error(`Refusing an unusual user name: ${JSON.stringify(ctx.user)}`);
    if (!NUMERIC_ID.test(ctx.uid) || !NUMERIC_ID.test(ctx.gid)) throw new Error("Refusing a non-numeric uid or gid.");
    if (ctx.user === "root" || ctx.uid === "0") throw new Error("The Inbox runs as root; the fixed address needs the person's own account.");
  }
}

/** The install words: plain HTTP on port 80, never a certificate, never --force. */
export const SERVICE_INSTALL_WORDS = ["service", "install", "--no-tls", "--port", String(INBOX_NAME_PROXY_PORT)] as const;

export interface PrivilegedOptions {
  /**
   * Plannotator's own earlier service is installed (the HTTPS one this
   * prototype used to install): run `service uninstall` first, inside the same
   * elevated command, so one password prompt replaces it. macOS and Linux only;
   * on Windows `schtasks /Create /F` in the install replaces the task itself.
   */
  replace?: boolean;
  /**
   * A folder the elevated command makes FIRST (`/bin/mkdir`, never following a
   * final symlink; on Windows the person's PowerShell makes it once UAC was
   * accepted), so the server knows the password went in. Only with the OS
   * prompt. Validated like every other path.
   */
  marker?: string;
}

/**
 * The launchctl shim's lines: `kickstart -k <service>` becomes `kickstart
 * <service>` (start it if it is not running; return at once if it is), so
 * launchd's 10-second respawn throttle after `bootstrap` never applies;
 * anything else goes to `target` unchanged. No `"` or `\` (it rides inside
 * an AppleScript string); portless's launchctl words hold no spaces, so `$@`
 * needs no quotes. `target` is a parameter for the tests only.
 */
export function launchctlShimLines(target = "/bin/launchctl"): string[] {
  return ["#!/bin/sh", `if [ $# -ge 2 ] && [ $1 = kickstart ] && [ $2 = -k ]; then shift 2; exec ${target} kickstart $@; fi`, `exec ${target} $@`];
}

/**
 * macOS: wrap `body` so it runs with the launchctl shim first on PATH. The
 * shim lives in a root-owned 0700 folder from mktemp under /tmp, made and
 * removed inside the same elevated command. Any failure making it leaves PATH
 * alone (the install then runs as before, 10 s slower). Keeps the body's exit.
 */
export function withLaunchctlShim(body: string): string {
  const write = launchctlShimLines()
    .map((line, i) => `echo '${line}' ${i === 0 ? ">" : ">>"} $d/launchctl`)
    .join(" && ");
  return `d=$(/usr/bin/mktemp -d /tmp/plannotator-launchctl.XXXXXX) && /bin/chmod 700 $d && ${write} && /bin/chmod 755 $d/launchctl && PATH=$d:/usr/bin:/bin:/usr/sbin:/sbin && export PATH ; ${body} ; s=$? ; /bin/rm -rf $d ; exit $s`;
}

/**
 * The one privileged command: `portless service install --no-tls --port 80
 * --state-dir <dir>`, preceded by `service uninstall` when `replace`. Every
 * value is validated (`assertSafePath`, `USER_NAME`, `NUMERIC_ID`), so it
 * carries no quote, backslash (POSIX), `$`, backtick, `;` or line break, and
 * is then quoted. Never `--force`.
 */
export function privilegedInstallCommand(platform: NodeJS.Platform, ctx: PrivilegedContext, mode: ElevationMode = "prompt", options: PrivilegedOptions = {}): CommandLine {
  validate(ctx, platform);
  const marker = mode === "prompt" && options.marker ? assertSafePath(options.marker, platform) : null;
  const portlessWords = [ctx.cli, ...SERVICE_INSTALL_WORDS, "--state-dir", ctx.stateDir];
  if (platform === "win32") {
    if (mode !== "prompt") return { command: ctx.node, args: portlessWords };
    // Start-Process -ArgumentList joins its words with spaces, so each path is wrapped in double quotes
    // (validated to hold none); the whole is one single-quoted PowerShell string (validated to hold no ').
    const argumentList = `"${ctx.cli}" ${SERVICE_INSTALL_WORDS.join(" ")} --state-dir "${ctx.stateDir}"`;
    const start = (wait: string) => `Start-Process -FilePath '${ctx.node}' -ArgumentList '${argumentList}' -Verb RunAs${wait} -PassThru -WindowStyle Hidden`;
    // With a marker: Start-Process returns once UAC was accepted (a refusal throws, and Stop ends the script there),
    // the marker is made as the person, then the elevated install is awaited.
    const script = marker
      ? `$ErrorActionPreference = 'Stop'; $p = ${start("")}; $null = $p.Handle; New-Item -ItemType Directory -Force -Path '${marker}' | Out-Null; $p.WaitForExit(); exit $p.ExitCode`
      : `$p = ${start(" -Wait")}; exit $p.ExitCode`;
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script] };
  }
  const env = ["/usr/bin/env", ...posixEnvWords(ctx), ctx.node];
  const install = [...env, ...portlessWords];
  const shellLine = (words: string[]) => words.map((word) => `'${word}'`).join(" ");
  // One shell line when replacing: the uninstall, then the install whatever the uninstall said
  // (the install boots out the same launchd label / systemd unit itself; the uninstall is belt and braces).
  let body = options.replace ? `${shellLine([...env, ctx.cli, "service", "uninstall"])} ; ${shellLine(install)}` : shellLine(install);
  // macOS: the launchctl shim (see the module comment: launchd's 10-second throttle).
  if (platform === "darwin") body = withLaunchctlShim(body);
  // The marker first, whatever it says: it only tells the window the password went in.
  const shell = marker ? `/bin/mkdir ${shellLine([marker])} ; ${body}` : body;
  if (platform === "darwin" && mode === "prompt") {
    // `do shell script` runs /bin/sh: every word single-quoted. The AppleScript string then holds no `"` or `\`.
    return { command: "/usr/bin/osascript", args: ["-e", `do shell script "${shell}" with administrator privileges with prompt "${INBOX_NAME_PROMPT}"`] };
  }
  // pkexec and sudo take an argv; a shell line (replace, marker, the macOS shim) runs through /bin/sh -c
  // (the polkit agent then names /bin/sh).
  const argv = shell === shellLine(install) ? install : ["/bin/sh", "-c", shell];
  if (mode === "direct") return { command: argv[0]!, args: argv.slice(1) };
  if (mode === "sudo") return { command: "sudo", args: ["-n", ...argv] };
  return { command: "pkexec", args: argv };
}

/** `portless alias inbox.plannotator <port>`: run as the person. A port number is the only variable. */
export function aliasCommand(node: string, cli: string, port: number): CommandLine {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Not a port: ${port}`);
  return { command: node, args: [cli, "alias", INBOX_NAME_LABEL, String(port)] };
}

export function aliasRemoveCommand(node: string, cli: string): CommandLine {
  return { command: node, args: [cli, "alias", "--remove", INBOX_NAME_LABEL] };
}

/** `npm install --prefix <home> portless@<pinned>` through the found Node's own npm-cli.js (no shell, no .cmd). */
export function npmInstallCommand(node: string, npmCli: string, home: string): CommandLine {
  return { command: node, args: [npmCli, "install", "--prefix", home, `portless@${PORTLESS_VERSION}`, "--no-save", "--no-audit", "--no-fund", "--loglevel=error"] };
}

/** What an osascript / pkexec / UAC refusal looks like, said plainly. */
export function explainPrivilegedFailure(platform: NodeJS.Platform, code: number | null, stderr: string): string {
  const text = stderr.trim();
  if (platform === "darwin" && /-128|User canceled/i.test(text)) return "You cancelled the password prompt. Nothing changed.";
  if (platform === "linux" && (code === 126 || code === 127) && /dismiss|not authorized|Request dismissed/i.test(text)) return "You cancelled the password prompt. Nothing changed.";
  if (platform === "win32" && /canceled by the user|cancelled by the user/i.test(text)) return "You cancelled the Windows prompt. Nothing changed.";
  return text ? `The privileged step failed: ${text.split("\n").slice(-3).join(" ")}` : `The privileged step failed (exit ${code ?? "?"}).`;
}

// ── Effects ─────────────────────────────────────────────────────────────────

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type NameRunner = (line: CommandLine, options: { env: Record<string, string | undefined>; timeoutMs: number }) => Promise<RunResult>;

/**
 * Run a command DETACHED (its own process group), so nothing it does to its
 * group (portless's `--force` path signals group 0) can reach the Inbox.
 * Output is capped; the group is killed at the time limit.
 */
export const runDetached: NameRunner = (line, { env, timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(line.command, line.args, { env: env as NodeJS.ProcessEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    const cap = (acc: string, chunk: Buffer) => (acc.length > 64_000 ? acc : acc + chunk.toString("utf8"));
    child.stdout?.on("data", (chunk: Buffer) => (stdout = cap(stdout, chunk)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = cap(stderr, chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

export type NameStatus = "unavailable" | "off" | "working" | "on" | "failed";
/**
 * Where setup is, for the window:
 * - `preparing`: fetching portless into the data folder (usually done before Sure, see `prefetch`).
 * - `password`: the OS password prompt is up.
 * - `installing`: the password went in (the marker appeared); the elevated install runs.
 * - `starting`: waiting for the proxy on port 80, then registering the name.
 * - `verifying`: checking the address answers this Inbox.
 */
export type NameStep = "preparing" | "password" | "installing" | "starting" | "verifying";

export interface InboxNameState {
  status: NameStatus;
  url: string;
  host: string;
  /** unavailable: why; failed: what went wrong (and that nothing changed when so). */
  reason: string | null;
  step: NameStep | null;
  /** The name listener's loopback port while on. */
  listener_port: number | null;
  /** The one-time dialog may show (available, off, never shown). */
  dialog_due: boolean;
  /** The prototype is switched on in this Inbox's environment (PLANNOTATOR_PROTO_FIXED_ADDRESS=1). Off: nothing runs and the window shows nothing. */
  prototype: boolean;
  verified_at: string | null;
  /** How the last probe went, for the checklist and CI. */
  probe: string | null;
  /** The commands run for it, newest last: what ran, its exit, the end of its output (for the checklist, CI and Try again). */
  log: string[];
  portless: { node: string | null; cli: string | null; state_dir: string; home: string };
}

interface NameFile {
  v: 1;
  on: boolean;
  port: number | null;
  dialog_shown: boolean;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export type NameProbe = (stateDir: string, serverSession: string) => Promise<ProbeResult>;

/** One health read; the serverSession it answered, or why not. */
async function healthAt(url: string, headers: Record<string, string>): Promise<{ session: string | null; detail: string }> {
  const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(4000) });
  if (!response.ok) return { session: null, detail: `answered HTTP ${response.status}${response.headers.get("location") ? ` -> ${response.headers.get("location")}` : ""}` };
  const body = (await response.json()) as { serverSession?: unknown };
  return { session: typeof body.serverSession === "string" ? body.serverSession : null, detail: response.headers.get("x-portless") ? "through portless" : "no X-Portless header" };
}

/**
 * Plain HTTP to the name, answering this Inbox's serverSession. Browsers
 * resolve `*.localhost` to loopback themselves; when this process cannot (an
 * older resolver, no /etc/hosts line yet), the same request goes to
 * 127.0.0.1:80 with the name as Host, which checks the route all the same.
 */
export const probeName: NameProbe = async (_stateDir, serverSession) => {
  let byName: string;
  try {
    const result = await healthAt(`${INBOX_NAME_URL}api/inbox/health`, {});
    if (result.session === serverSession) return { ok: true, detail: `http ok (${result.detail})` };
    byName = result.session ? "the name answered another Inbox (serverSession differs)" : `the name ${result.detail}`;
  } catch (error) {
    byName = `the name did not answer (${error instanceof Error ? error.message : String(error)})`;
  }
  try {
    const result = await healthAt(`http://127.0.0.1:${INBOX_NAME_PROXY_PORT}/api/inbox/health`, { host: INBOX_NAME_HOST });
    if (result.session === serverSession) return { ok: true, detail: `http ok through 127.0.0.1:${INBOX_NAME_PROXY_PORT} (${result.detail}); ${byName}` };
    return { ok: false, detail: `${byName}; 127.0.0.1:${INBOX_NAME_PROXY_PORT} ${result.session ? "answered another Inbox" : result.detail}` };
  } catch (error) {
    return { ok: false, detail: `${byName}; nothing answers on port ${INBOX_NAME_PROXY_PORT} (${error instanceof Error ? error.message : String(error)})` };
  }
};

/** What answers on port 80: nothing, portless in plain HTTP, portless redirecting to HTTPS, or another program. */
export type ProxyState = { kind: "free" } | { kind: "http" } | { kind: "https" } | { kind: "other"; detail: string };

/** Classify an answer from port 80 (pure; unit-tested). */
export function classifyPort80(status: number, headers: Headers): ProxyState {
  if (headers.get("x-portless") === null) {
    const server = headers.get("server");
    return { kind: "other", detail: `it answered HTTP ${status}${server ? ` as "${server.slice(0, 80)}"` : ""}` };
  }
  const location = headers.get("location") ?? "";
  if (status >= 300 && status < 400 && /^https:/i.test(location)) return { kind: "https" };
  return { kind: "http" };
}

/**
 * Look at 127.0.0.1:80 without following anything. Refused: free. An HTTP
 * answer: classified by its `X-Portless` header and a redirect to https. Any
 * other failure (a listener that does not speak HTTP, a hang): another program.
 */
export async function readProxyState(port: number = INBOX_NAME_PROXY_PORT): Promise<ProxyState> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: INBOX_NAME_HOST }, redirect: "manual", signal: AbortSignal.timeout(5000) });
    await response.body?.cancel().catch(() => {});
    return classifyPort80(response.status, response.headers);
  } catch (error) {
    const text = `${error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error)}`;
    if (/ECONNREFUSED|ConnectionRefused|refused/i.test(text)) return { kind: "free" };
    return { kind: "other", detail: `something holds the port but did not answer HTTP (${text.trim().slice(0, 120)})` };
  }
}

/** portless's service file: launchd plist (macOS), systemd unit (Linux). Windows: none read (the install's /F replaces its task). */
export function serviceFilePath(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") return "/Library/LaunchDaemons/sh.portless.proxy.plist";
  if (platform === "linux") return "/etc/systemd/system/portless.service";
  return null;
}

export interface ExistingService {
  path: string;
  /** It runs Plannotator's own copy of portless (the cli.js under the data dir). */
  ours: boolean;
  /** It starts the proxy with --https or --cert (the earlier prototype's service, or someone's own HTTPS setup). */
  https: boolean;
}

/** Read portless's installed service, if any (world-readable files; nothing privileged). */
export function readExistingService(platform: NodeJS.Platform, cli: string, path: string | null = serviceFilePath(platform)): ExistingService | null {
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return { path, ours: text.includes(cli), https: /--(https|cert)\b/.test(text) && !/--no-tls\b/.test(text) };
}

/** The end of portless's service log, for a proxy that never came up (EADDRINUSE: port 80 taken). */
function serviceLogTail(stateDir: string): string {
  try {
    return readFileSync(join(stateDir, "service.log"), "utf8").trim().split("\n").slice(-3).join(" | ").slice(-400);
  } catch {
    return "";
  }
}

export interface InboxNameOptions {
  dataDir: string;
  serverSession: string;
  /** The window's handler (requests the name listener let in). */
  dispatch: (req: Request) => Promise<Response>;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  runner?: NameRunner;
  probe?: NameProbe;
  /** Tests: Node's path and version without running it. */
  findNode?: () => Promise<{ node: string; version: string } | null>;
  /** Tests: what answers on port 80. Default: `readProxyState`. */
  proxyState?: () => Promise<ProxyState>;
  /** Tests: portless's installed service. Default: `readExistingService`. */
  existingService?: () => ExistingService | null;
  /** Tests: the person running the Inbox. Default: `os.userInfo()`. */
  user?: () => { username: string; uid: number; gid: number };
  /** Tests: shorten the waits for the proxy and the route. */
  pollMs?: number;
  pollTries?: number;
  /** How long to wait for portless's proxy after the privileged step. Default 90 s (a CI Mac took over 15). */
  proxyWaitMs?: number;
}

export interface InboxName {
  /** At Inbox start: if on, open the listener, re-register the alias, probe. Never throws. */
  start(): Promise<void>;
  state(): InboxNameState;
  /** Refresh availability (Node lookup); cheap after the first call. */
  refresh(): Promise<InboxNameState>;
  /** Sure / `--name on`: runs in the background; poll `state()`. */
  enable(): InboxNameState;
  disable(): Promise<InboxNameState>;
  /** Compare-and-set: the first ask while due gets true (and portless starts downloading in the background). */
  claimDialog(): boolean;
  /** Fetch portless in the background; idempotent. */
  prefetch(): void;
  listenerPort(): number | null;
  stop(): void;
}

export function createInboxName(options: InboxNameOptions): InboxName {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.probe ?? probeName;
  const pollMs = options.pollMs ?? SETUP_POLL_MS;
  const pollTries = options.pollTries ?? 30;
  const proxyWaitMs = options.proxyWaitMs ?? 90_000;
  const log: string[] = [];
  const note = (text: string) => {
    log.push(`${new Date().toISOString()} ${text}`);
    if (log.length > 20) log.splice(0, log.length - 20);
  };
  /** Run a command and keep a line about it (never its environment): logged when it ENDS, with how long it took. */
  const exec: NameRunner = async (line, opts) => {
    const began = Date.now();
    const result = await (options.runner ?? runDetached)(line, opts);
    const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-4).join(" | ").slice(0, 600);
    note(`${[line.command, ...line.args].join(" ").slice(0, 900)} -> ${result.timedOut ? "timed out" : `exit ${result.code}`} in ${Date.now() - began} ms${tail ? `: ${tail}` : ""}`);
    return result;
  };
  const file = join(inboxDir(options.dataDir), NAME_FILE);
  const setupDir = join(inboxDir(options.dataDir), SETUP_DIR);
  const home = env.PLANNOTATOR_PROTO_PORTLESS_HOME || join(options.dataDir, "portless");
  const userHome = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  const stateDir = env.PLANNOTATOR_PROTO_PORTLESS_STATE_DIR || join(userHome, ".portless");
  const cli = join(home, "node_modules", "portless", "dist", "cli.js");
  // Zero footprint unless switched on: no Node lookup, no listener, no process, no window row.
  const enabledHere = env.PLANNOTATOR_PROTO_FIXED_ADDRESS === "1";
  const elevation: ElevationMode = env.PLANNOTATOR_PROTO_NAME_ELEVATE === "sudo" ? "sudo" : env.PLANNOTATOR_PROTO_NAME_ELEVATE === "direct" ? "direct" : "prompt";

  const readFile = (): NameFile => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Partial<NameFile>;
      return { v: 1, on: value.on === true, port: typeof value.port === "number" ? value.port : null, dialog_shown: value.dialog_shown === true };
    } catch {
      return { v: 1, on: false, port: null, dialog_shown: false };
    }
  };
  const writeFile = (next: NameFile) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  };

  let saved = readFile();
  let status: NameStatus = "off";
  let step: NameStep | null = null;
  let reason: string | null = null;
  let verifiedAt: string | null = null;
  let probeDetail: string | null = null;
  let node: { node: string; version: string } | null = null;
  let nodeChecked = false;
  let nodeLookup: Promise<{ node: string; version: string } | null> | null = null;
  let listener: ReturnType<typeof Bun.serve> | null = null;
  let job: Promise<void> | null = null;
  let fetching: Promise<string | null> | null = null;
  let stopped = false;

  const childEnv = (): Record<string, string | undefined> => ({
    ...env,
    PORTLESS_STATE_DIR: stateDir,
    // Plain HTTP for every portless command the person runs too (alias reads the proxy's port from the state dir).
    PORTLESS_HTTPS: "0",
    PATH: node ? `${dirname(node.node)}${delimiter}${env.PATH ?? ""}` : env.PATH,
    // Never let a portless child think it is a CI or non-interactive context it is not.
    PORTLESS: undefined,
  });

  const findNode =
    options.findNode ??
    (async () => {
      const candidates = [env.PLANNOTATOR_PROTO_NODE, Bun.which("node", { PATH: env.PATH ?? "" }) ?? undefined].filter((c): c is string => !!c);
      for (const candidate of candidates) {
        let real: string;
        try {
          real = realpathSync(candidate);
        } catch {
          continue;
        }
        // A busy machine can take seconds to start Node (a CI Mac's first restart did); logged either way.
        const result = await exec({ command: real, args: ["--version"] }, { env: { ...env }, timeoutMs: 20_000 });
        if (result.code === 0) return { node: real, version: result.stdout.trim() };
      }
      return null;
    });

  const ensureNode = async (): Promise<string | null> => {
    // One lookup at a time (start and a window's GET race at every start: the first CI Mac
    // restart read "no Node" from a lookup still running), and only a found Node is kept.
    if (!nodeChecked || !node) {
      nodeLookup ??= findNode()
        .catch(() => null)
        .finally(() => {
          nodeLookup = null;
        });
      node = await nodeLookup;
      nodeChecked = node !== null;
    }
    if (!node) return `Needs Node 24 or newer on this computer (portless runs on it). None was found on this Inbox's PATH${log.length ? ` (last: ${log[log.length - 1]})` : ""}.`;
    const major = nodeMajor(node.version);
    if (major === null || major < PORTLESS_MIN_NODE_MAJOR) return `Needs Node 24 or newer; found ${node.version} at ${node.node}.`;
    return null;
  };

  /**
   * portless into <data dir>/portless, as the person; idempotent and one at a
   * time. Started when the dialog is shown (`prefetch`), so Sure never waits on
   * npm before the prompt; Sure awaits the same promise. Null when ready.
   */
  const ensurePortless = (): Promise<string | null> => {
    if (existsSync(cli)) return Promise.resolve(null);
    fetching ??= (async () => {
      if (await ensureNode()) return "Node 24 or newer is missing.";
      const found = node!;
      const npmCli = [join(dirname(found.node), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(found.node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((p) => existsSync(p));
      if (!npmCli) return `npm was not found next to ${found.node}.`;
      mkdirSync(home, { recursive: true });
      const installed = await exec(npmInstallCommand(found.node, npmCli, home), { env: childEnv(), timeoutMs: NPM_TIMEOUT_MS });
      if (installed.code !== 0 || !existsSync(cli)) return `Installing portless ${PORTLESS_VERSION} failed: ${(installed.stderr || installed.stdout).trim().slice(-400) || `exit ${installed.code}`}`;
      return null;
    })()
      .catch((error) => (error instanceof Error ? error.message : String(error)))
      .finally(() => {
        fetching = null;
      });
    return fetching;
  };

  /** Fetch portless in the background (never throws, never waits). */
  const prefetch = () => {
    if (!enabledHere || stopped || existsSync(cli)) return;
    void ensurePortless();
  };

  /**
   * The privileged step, with the marker watched: `password` until the
   * elevated command made the marker, then `installing`. The marker's name is
   * fresh per run, in a folder the person owns made before the prompt; it is
   * removed after.
   */
  const runPrivileged = async (line: CommandLine, marker: string | null): Promise<RunResult> => {
    const began = Date.now();
    let seen = false;
    const look = () => {
      if (!seen && marker && existsSync(marker)) {
        seen = true;
        step = "installing";
        note(`password accepted (marker seen) after ${Date.now() - began} ms`);
      }
    };
    const watch = marker ? setInterval(look, SETUP_POLL_MS) : null;
    try {
      return await exec(line, { env: childEnv(), timeoutMs: PRIVILEGED_TIMEOUT_MS });
    } finally {
      if (watch) clearInterval(watch);
      look();
      if (marker) rmSync(marker, { recursive: true, force: true });
    }
  };

  const openListener = (): number => {
    if (listener) return listener.port as number;
    const serve = (port: number) =>
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        fetch(req: Request, server: { requestIP(r: Request): { address: string } | null }) {
          const url = new URL(req.url, `http://${INBOX_NAME_HOST}`);
          const verdict = checkNameRequest(req.headers, url.pathname, server.requestIP(req)?.address ?? null);
          if (!verdict.ok) {
            return new Response(JSON.stringify({ error: verdict.error, code: verdict.code }), {
              status: verdict.status,
              headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
            });
          }
          return options.dispatch(req);
        },
      } as Parameters<typeof Bun.serve>[0]);
    if (saved.port) {
      try {
        listener = serve(saved.port);
      } catch {
        listener = null;
      }
    }
    if (!listener) listener = serve(0);
    return listener.port as number;
  };

  /** `later`: the request that turned it off may have come through this listener; let its answer go first. */
  const closeListener = (later = false) => {
    const closing = listener;
    listener = null;
    if (!closing) return;
    if (!later) return void closing.stop(true);
    setTimeout(() => closing.stop(true), 300);
  };

  const lanMode = () => existsSync(join(stateDir, "proxy.lan"));

  const alias = async (port: number): Promise<string | null> => {
    if (!node) return "Node is missing.";
    if (lanMode()) return "portless runs in LAN mode (proxy.lan): the alias would put the Inbox on the network. Refused.";
    const result = await exec(aliasCommand(node.node, cli, port), { env: childEnv(), timeoutMs: ALIAS_TIMEOUT_MS });
    if (result.code !== 0) return `portless alias failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`;
    return null;
  };

  const verify = async (): Promise<boolean> => {
    for (let i = 0; i < pollTries && !stopped; i++) {
      const result = await probe(stateDir, options.serverSession);
      probeDetail = result.detail;
      if (result.ok) {
        verifiedAt = new Date().toISOString();
        return true;
      }
      await Bun.sleep(pollMs);
    }
    return false;
  };

  const fail = (message: string) => {
    status = "failed";
    reason = message;
    step = null;
  };

  const run = async (): Promise<void> => {
    reason = null;
    const missing = await ensureNode();
    if (missing) {
      status = "unavailable";
      reason = missing;
      step = null;
      return;
    }
    // 2. Port 80 first, before anything is installed: refuse what we must not replace, with no prompt.
    const readState = options.proxyState ?? (() => readProxyState());
    const before = await readState();
    const service = (options.existingService ?? (() => readExistingService(platform, cli)))();
    if (before.kind === "other") {
      return fail(`Port ${INBOX_NAME_PROXY_PORT} is already used by another program on this computer (${before.detail}). The fixed address needs that port. Nothing changed; the Inbox stays at localhost.`);
    }
    if ((before.kind === "https" || service?.https) && !service?.ours) {
      return fail("portless is already set up on this computer with HTTPS, by something other than Plannotator. Plannotator leaves it alone. Nothing changed; the Inbox stays at localhost.");
    }
    const port = openListener();
    // 3. portless into <data dir>/portless, as the person (usually fetched already, when the dialog showed).
    if (!existsSync(cli)) {
      step = "preparing";
      const fetchError = await ensurePortless();
      if (fetchError) return fail(fetchError);
    }
    // 4. The one privileged step, only when a plain-HTTP portless is not already answering.
    if (before.kind !== "http") {
      // No OS prompt in the CI modes: straight to installing.
      step = elevation === "prompt" ? "password" : "installing";
      let line: CommandLine;
      let marker: string | null = null;
      try {
        const me = options.user ? options.user() : platform === "win32" ? { username: env.USERNAME ?? "", uid: -1, gid: -1 } : userInfo();
        if (elevation === "prompt") {
          mkdirSync(setupDir, { recursive: true, mode: 0o700 });
          for (const stale of readdirSync(setupDir)) rmSync(join(setupDir, stale), { recursive: true, force: true });
          marker = join(setupDir, `accepted-${randomBytes(8).toString("hex")}`);
        }
        line = privilegedInstallCommand(
          platform,
          { node: node!.node, cli, stateDir, user: me.username, uid: String(me.uid), gid: String(me.gid), home: userHome },
          elevation,
          // Plannotator's own earlier service (the HTTPS one): replaced in the same prompt.
          { replace: !!service?.ours, ...(marker ? { marker } : {}) },
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      const result = await runPrivileged(line, marker);
      if (result.timedOut) return fail("The password prompt timed out. Nothing changed.");
      if (result.code !== 0) return fail(explainPrivilegedFailure(platform, result.code, result.stderr || result.stdout));
      step = "starting";
      let up = false;
      const waitBegan = Date.now();
      const until = waitBegan + proxyWaitMs;
      while (!stopped && Date.now() < until) {
        if ((await readState()).kind === "http") {
          up = true;
          break;
        }
        await Bun.sleep(pollMs);
      }
      note(up ? `the proxy answered on port ${INBOX_NAME_PROXY_PORT} after ${Date.now() - waitBegan} ms` : `the proxy did not answer within ${proxyWaitMs} ms`);
      if (!up) {
        const tail = serviceLogTail(stateDir);
        if (/EADDRINUSE/i.test(tail)) return fail(`Port ${INBOX_NAME_PROXY_PORT} is used by another program, so portless's proxy could not start. The Inbox stays at localhost. (${tail})`);
        return fail(`portless was installed but its proxy did not answer on port ${INBOX_NAME_PROXY_PORT} within ${Math.round(proxyWaitMs / 1000)} s.${tail ? ` Its log: ${tail}` : ""} Run: portless doctor`);
      }
    }
    // 5. The alias, as the person.
    step = "starting";
    const aliasError = await alias(port);
    if (aliasError) return fail(aliasError);
    // 6. Verify.
    step = "verifying";
    const verifyBegan = Date.now();
    const verified = await verify();
    note(`verify ${verified ? "answered" : "gave up"} after ${Date.now() - verifyBegan} ms`);
    if (!verified) return fail(`The address does not answer this Inbox yet: ${probeDetail ?? "no answer"}. localhost still works.`);
    saved = { ...readFile(), on: true, port };
    writeFile(saved);
    status = "on";
    step = null;
    reason = null;
  };

  const state = (): InboxNameState => ({
    status,
    url: INBOX_NAME_URL,
    host: INBOX_NAME_HOST,
    reason,
    step,
    listener_port: listener ? (listener.port as number) : null,
    dialog_due: enabledHere && status === "off" && !readFile().dialog_shown,
    prototype: enabledHere,
    verified_at: verifiedAt,
    probe: probeDetail,
    log: [...log],
    portless: { node: node?.node ?? null, cli: existsSync(cli) ? cli : null, state_dir: stateDir, home },
  });

  const refresh = async (): Promise<InboxNameState> => {
    if (!enabledHere) {
      status = "unavailable";
      reason = "Prototype off: start the Inbox with PLANNOTATOR_PROTO_FIXED_ADDRESS=1.";
      return state();
    }
    if (status === "off" || status === "unavailable") {
      const missing = await ensureNode();
      if (missing) {
        status = "unavailable";
        reason = missing;
      } else if (status === "unavailable") {
        status = "off";
        reason = null;
      }
    }
    return state();
  };

  return {
    async start() {
      try {
        if (!enabledHere || !saved.on) {
          await refresh();
          return;
        }
        // On at the last run: same listener port when free, the alias re-pointed (no prompt), then
        // the probe. "working" from the first moment, so a window reading the state meanwhile waits.
        status = "working";
        step = "starting";
        const missing = await ensureNode();
        if (missing) {
          status = "unavailable";
          reason = missing;
          step = null;
          return;
        }
        const port = openListener();
        if (!existsSync(cli)) return fail("portless is no longer installed; turn the fixed address on again.");
        const aliasError = await alias(port);
        if (aliasError) return fail(aliasError);
        step = "verifying";
        if (!(await verify())) return fail(`The address does not answer this Inbox: ${probeDetail ?? "no answer"}. localhost still works.`);
        if (saved.port !== port) {
          saved = { ...readFile(), on: true, port };
          writeFile(saved);
        }
        status = "on";
        step = null;
        reason = null;
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },
    state,
    refresh,
    enable() {
      if (!enabledHere || status === "working" || status === "on") return state();
      status = "working";
      step = null;
      reason = null;
      job = run()
        .catch((error) => fail(error instanceof Error ? error.message : String(error)))
        .finally(() => {
          job = null;
        });
      return state();
    },
    async disable() {
      if (!enabledHere) return state();
      if (job) await job;
      // Remove the alias only when it is ours: the hostname, a static route (pid 0), our listener's port.
      const port = listener ? (listener.port as number) : saved.port;
      if (node && existsSync(cli) && port !== null) {
        try {
          const routes = JSON.parse(readFileSync(join(stateDir, "routes.json"), "utf8")) as { hostname?: string; port?: number; pid?: number }[];
          const ours = Array.isArray(routes) && routes.some((r) => r.hostname === INBOX_NAME_HOST && r.pid === 0 && r.port === port);
          if (ours) await exec(aliasRemoveCommand(node.node, cli), { env: childEnv(), timeoutMs: ALIAS_TIMEOUT_MS });
        } catch {
          // No routes file: nothing to remove.
        }
      }
      closeListener(true);
      saved = { ...readFile(), on: false, port: saved.port };
      writeFile(saved);
      status = "off";
      step = null;
      reason = null;
      verifiedAt = null;
      return refresh();
    },
    claimDialog() {
      const current = readFile();
      if (!enabledHere || status !== "off" || current.dialog_shown) return false;
      writeFile({ ...current, dialog_shown: true });
      saved = { ...saved, dialog_shown: true };
      // The person is reading the offer: fetch portless now, so Sure goes straight to the password prompt.
      prefetch();
      return true;
    },
    prefetch,
    listenerPort: () => (listener ? (listener.port as number) : null),
    stop() {
      stopped = true;
      // A clean stop keeps the alias: the sticky port comes back next run.
      closeListener();
    },
  };
}
