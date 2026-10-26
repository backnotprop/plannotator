/**
 * Cross-platform browser opening utility
 */

import { childPath } from "@plannotator/shared/child-env";
import { $ } from "bun";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { loadConfig, resolveUseGlimpse } from "@plannotator/shared/config";
import {
  browserNoneReason,
  isNoOpBrowserSentinel,
  resolveBrowserIntent,
} from "@plannotator/shared/browser-intent";

function ipcRegistryPath(): string {
  return path.join(getPlannotatorDataDir(), "vscode-ipc.json");
}

/**
 * The browser rule lives in @plannotator/shared/browser-intent (shared with
 * Pi): a "none" value on PLANNOTATOR_BROWSER opens nothing; BROWSER's no-op
 * values (#756, e.g. Claude Code's agent view sets BROWSER=true) are read as
 * unset so the default chain still runs.
 */
export { isNoOpBrowserSentinel };

/**
 * Try opening URL via VS Code extension IPC registry.
 * Falls back when env vars (PLANNOTATOR_BROWSER) aren't available to the process.
 */
export async function tryVscodeIpc(url: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
  try {
    const registry: Record<string, number> = JSON.parse(
      fs.readFileSync(ipcRegistryPath(), "utf-8"),
    );
    const cwd = process.cwd();
    // Find the best matching workspace (longest prefix match)
    let bestMatch = "";
    let bestPort = 0;
    for (const [workspace, port] of Object.entries(registry)) {
      if (cwd.startsWith(workspace) && workspace.length > bestMatch.length) {
        bestMatch = workspace;
        bestPort = port;
      }
    }
    if (!bestPort) return false;
    const ipcUrl = new URL("/open", `http://127.0.0.1:${bestPort}`);
    ipcUrl.searchParams.set("url", url);
    const resp = await fetch(
      ipcUrl.toString(),
      options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : undefined,
    );
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Check if running in WSL (Windows Subsystem for Linux)
 */
export async function isWSL(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }

  if (os.release().toLowerCase().includes("microsoft")) {
    return true;
  }

  // Fallback: check /proc/version for WSL signature (if available)
  try {
    const file = Bun.file("/proc/version");
    if (await file.exists()) {
      const content = await file.text();
      return (
        content.toLowerCase().includes("wsl") ||
        content.toLowerCase().includes("microsoft")
      );
    }
  } catch {
    // Ignore errors reading /proc/version
  }
  return false;
}

/**
 * True for a value that must be handed to cmd.exe under WSL: a Windows-style
 * path (C:\..., C:/...) or a /mnt/<drive> mount of one, or a `.exe` name.
 */
function isWindowsBrowserTarget(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("/mnt/") ||
    value.toLowerCase().endsWith(".exe")
  );
}

/**
 * Resolve PLANNOTATOR_BROWSER to an executable the Linux side can run
 * directly: a POSIX path (/..., ./..., ../...) verbatim, or a bare name's
 * absolute location on the Linux PATH. Null for values that must go through
 * cmd.exe under WSL instead (a .exe, C:\\..., /mnt/<drive>) (#1472).
 */
export function resolvePosixBrowserTarget(value: string): string | null {
  if (isWindowsBrowserTarget(value)) return null;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return value;
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    try {
      const candidate = path.join(entry, value);
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // Not an executable on this PATH entry.
    }
  }
  return null;
}

/**
 * True when PLANNOTATOR_BROWSER names something the Linux side can execute
 * itself. Under WSL those must NOT go through cmd.exe, which cannot resolve
 * them (#1472).
 */
export function isPosixBrowserTarget(value: string): boolean {
  return resolvePosixBrowserTarget(value) !== null;
}

/**
 * Open a URL in the browser
 *
 * Uses PLANNOTATOR_BROWSER env var if set, otherwise uses system default.
 * - macOS: Set to app name ("Google Chrome") or path ("/Applications/Firefox.app")
 * - Linux/Windows/WSL: Set to executable path ("/usr/bin/firefox")
 *
 * Fails silently if browser can't be opened
 */
export function shouldTryRemoteBrowserFallback(isRemote: boolean): boolean {
  if (!isRemote) return false;
  // Only the default chain asks VS Code: an explicit handler runs itself, and
  // PLANNOTATOR_BROWSER=none opens nothing at all. BROWSER's no-op values
  // (BROWSER=true from Claude Code's agent view) count as unset, so the IPC
  // fallback still runs for them.
  return resolveBrowserIntent(process.env).kind === "default";
}

function buildGlimpseHtml(url: string): string {
  const encodedUrl = JSON.stringify(url);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Plannotator</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; }
      body { overflow: hidden; background: #0f1115; }
    </style>
  </head>
  <body>
    <script>
      location.replace(${encodedUrl});
    </script>
  </body>
</html>`;
}

async function openGlimpse(url: string): Promise<boolean> {
  const glimpseCli = Bun.which("glimpseui", { PATH: childPath() });
  if (!glimpseCli) return false;

  const args = [
    "--width",
    String(Number(process.env.PLANNOTATOR_GLIMPSE_WIDTH || 1280)),
    "--height",
    String(Number(process.env.PLANNOTATOR_GLIMPSE_HEIGHT || 900)),
    "--title",
    "Plannotator",
    "--open-links",
  ];
  const html = buildGlimpseHtml(url);

  // On Windows, `glimpseui` resolves to an npm script shim, not an exe, which
  // spawn() can't launch without a shell. `shell: true` would break the stdin
  // HTML pipe below, so run the package entry with node directly instead.
  let command = glimpseCli;
  let spawnArgs = args;
  if (process.platform === "win32" && !/\.exe$/i.test(glimpseCli)) {
    const node = Bun.which("node", { PATH: childPath() });
    const entry = path.join(
      path.dirname(glimpseCli),
      "node_modules",
      "glimpseui",
      "bin",
      "glimpse.mjs"
    );
    if (node && fs.existsSync(entry)) {
      command = node;
      spawnArgs = [entry, ...args];
    }
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let successTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      if (successTimer) clearTimeout(successTimer);
      resolve(opened);
    };

    const child = spawn(command, spawnArgs, {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    successTimer = setTimeout(() => {
      child.unref();
      finish(true);
    }, 750);

    child.once("error", () => finish(false));
    child.once("exit", () => finish(false));
    child.stdin.once("error", () => finish(false));
    child.stdin.end(html);
  });
}

/**
 * Open a URL in the browser. Returns false when nothing was opened.
 *
 * `PLANNOTATOR_BROWSER=none` (any "none" value, see browser-intent) opens
 * nothing at all and says so in one stderr line.
 */
/**
 * The command that opens `url`: the configured browser (`browser`, and
 * `plannotatorBrowser` when it came from PLANNOTATOR_BROWSER), else the
 * system opener. Shared by openBrowser and openBrowserDetached.
 */
async function browserLaunchArgv(
  url: string,
  browser: string | undefined,
  plannotatorBrowser: string | undefined,
): Promise<string[]> {
  const platform = process.platform;
  const wsl = await isWSL();
  // Under WSL a Linux executable must run directly; cmd.exe only wins for
  // Windows targets (a .exe, a C:\ path, a /mnt/<drive> path). Spawning the
  // RESOLVED absolute path also sidesteps Bun 1.3's shell, which resolves
  // bare command names against the PATH captured at startup (#1472).
  const posixTarget = wsl && plannotatorBrowser
    ? resolvePosixBrowserTarget(plannotatorBrowser)
    : null;
  const viaCmdExe =
    (platform === "win32" || wsl) &&
    !!plannotatorBrowser &&
    posixTarget === null;

  if (browser) {
    if (plannotatorBrowser && platform === "darwin") {
      return plannotatorBrowser.includes("/") && !plannotatorBrowser.endsWith(".app")
        ? [plannotatorBrowser, url]
        : ["open", "-a", plannotatorBrowser, url];
    }
    if (viaCmdExe) return ["cmd.exe", "/c", "start", "", plannotatorBrowser!, url];
    return [posixTarget ?? browser, url];
  }
  // Default system browser
  if (platform === "win32" || wsl) return ["cmd.exe", "/c", "start", url];
  if (platform === "darwin") return ["open", url];
  return ["xdg-open", url];
}

/** How long openBrowserDetached waits on the VS Code extension's IPC. */
const DETACHED_IPC_TIMEOUT_MS = 2_000;

/**
 * Open `url` and return at once, for a command that must not wait on the
 * browser (`plannotator inbox --open`). openBrowser waits for the opener and
 * every process that keeps its output open, which can be the whole browser
 * (xdg-open starting a fresh Firefox, PLANNOTATOR_BROWSER naming an
 * executable). Here the opener runs in its own process group with no stdio
 * and is not waited for.
 *
 * In a remote session with no browser configured, only the VS Code extension
 * is asked: the system opener would open a browser on the remote host.
 * Answers `opened`, `none` (a "none" PLANNOTATOR_BROWSER), `remote` (remote,
 * nothing could open it here) or `failed`.
 */
export async function openBrowserDetached(
  url: string,
  options: { isRemote?: boolean } = {},
): Promise<"opened" | "none" | "remote" | "failed"> {
  const intent = resolveBrowserIntent(process.env);
  if (intent.kind === "none") {
    process.stderr.write(`  ${browserNoneReason(intent)}\n`);
    return "none";
  }
  if (shouldTryRemoteBrowserFallback(options.isRemote ?? false)) {
    return (await tryVscodeIpc(url, { timeoutMs: DETACHED_IPC_TIMEOUT_MS })) ? "opened" : "remote";
  }
  const browser = intent.kind === "explicit" ? intent.browser : undefined;
  const plannotatorBrowser = intent.kind === "explicit" && intent.source === "PLANNOTATOR_BROWSER"
    ? intent.browser
    : undefined;
  const argv = await browserLaunchArgv(url, browser, plannotatorBrowser);
  const started = await new Promise<string | null>((resolve) => {
    try {
      const child = spawn(argv[0]!, argv.slice(1), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, PATH: childPath() },
      });
      child.once("spawn", () => {
        child.unref();
        resolve(null);
      });
      child.once("error", (error) => resolve(error.message));
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error));
    }
  });
  if (started === null) return "opened";
  if (plannotatorBrowser) {
    process.stderr.write(`Plannotator: could not launch PLANNOTATOR_BROWSER="${plannotatorBrowser}": ${started}\n`);
  }
  return (await tryVscodeIpc(url, { timeoutMs: DETACHED_IPC_TIMEOUT_MS })) ? "opened" : "failed";
}

export async function openBrowser(
  url: string,
  options?: { isRemote?: boolean; useGlimpse?: boolean }
): Promise<boolean> {
  const intent = resolveBrowserIntent(process.env);
  if (intent.kind === "none") {
    process.stderr.write(`  ${browserNoneReason(intent)}\n`);
    return false;
  }
  const plannotatorBrowser = intent.kind === "explicit" && intent.source === "PLANNOTATOR_BROWSER"
    ? intent.browser
    : undefined;
  try {
    const browser = intent.kind === "explicit" ? intent.browser : undefined;
    const isRemote = options?.isRemote ?? false;
    if (shouldTryRemoteBrowserFallback(isRemote)) {
      const openedViaIpc = await tryVscodeIpc(url);
      if (openedViaIpc) {
        return true;
      }
    }

    if (options?.useGlimpse && !browser && !isRemote && resolveUseGlimpse(loadConfig())) {
      const openedViaGlimpse = await openGlimpse(url);
      if (openedViaGlimpse) {
        return true;
      }
    }

    await $`${await browserLaunchArgv(url, browser, plannotatorBrowser)}`.quiet();
    return true;
  } catch (error) {
    // An explicitly configured browser that fails is otherwise invisible:
    // warn before falling back to the VS Code IPC registry (#1472).
    if (plannotatorBrowser) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Plannotator: could not launch PLANNOTATOR_BROWSER="${plannotatorBrowser}": ${message}\n`,
      );
    }
    // Shell-based open failed — try VS Code IPC registry as fallback
    return tryVscodeIpc(url);
  }
}
