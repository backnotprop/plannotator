/**
 * Cross-platform browser opening utility
 */

import { $ } from "bun";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { loadConfig, resolveUseGlimpse } from "@plannotator/shared/config";

const IPC_REGISTRY = path.join(getPlannotatorDataDir(), "vscode-ipc.json");

/**
 * Common "no-op" values for $BROWSER used by headless/background environments
 * (e.g. Claude Code's agent view sets BROWSER=true) to signal "do not actually
 * launch a browser". Treating these as if the variable were unset prevents
 * silently shelling out to e.g. `true <url>`, which exits 0 without opening
 * anything and leaves the Plannotator server hanging on waitForDecision().
 */
const NOOP_BROWSER_VALUES = new Set(["true", "false", "none", ":", "0", "1"]);

export function isNoOpBrowserSentinel(value: string | undefined): boolean {
  if (!value) return false;
  return NOOP_BROWSER_VALUES.has(value.trim().toLowerCase());
}

/**
 * Try opening URL via VS Code extension IPC registry.
 * Falls back when env vars (PLANNOTATOR_BROWSER) aren't available to the process.
 */
async function tryVscodeIpc(url: string): Promise<boolean> {
  try {
    const registry: Record<string, number> = JSON.parse(
      fs.readFileSync(IPC_REGISTRY, "utf-8"),
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
    const resp = await fetch(ipcUrl.toString());
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
  const plannotatorBrowser = process.env.PLANNOTATOR_BROWSER;
  const browser = process.env.BROWSER;
  // Treat headless sentinels (e.g. BROWSER=true from Claude Code's agent view)
  // as if no real browser handler were configured, so the IPC fallback still runs.
  const hasRealHandler =
    (plannotatorBrowser && !isNoOpBrowserSentinel(plannotatorBrowser)) ||
    (browser && !isNoOpBrowserSentinel(browser));
  return !hasRealHandler;
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
  const glimpseCli = Bun.which("glimpseui");
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
    const node = Bun.which("node");
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

export async function openBrowser(
  url: string,
  options?: { isRemote?: boolean; useGlimpse?: boolean }
): Promise<boolean> {
  const rawPlannotatorBrowser = process.env.PLANNOTATOR_BROWSER;
  const plannotatorBrowser = isNoOpBrowserSentinel(rawPlannotatorBrowser)
    ? undefined
    : rawPlannotatorBrowser;
  try {
    const rawBrowser = process.env.BROWSER;
    const envBrowser = isNoOpBrowserSentinel(rawBrowser) ? undefined : rawBrowser;
    const browser = plannotatorBrowser || envBrowser;
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
        if (plannotatorBrowser.includes("/") && !plannotatorBrowser.endsWith(".app")) {
          await $`${plannotatorBrowser} ${url}`.quiet();
        } else {
          await $`open -a ${plannotatorBrowser} ${url}`.quiet();
        }
      } else if (viaCmdExe) {
        await $`cmd.exe /c start "" ${plannotatorBrowser} ${url}`.quiet();
      } else {
        await $`${posixTarget ?? browser} ${url}`.quiet();
      }
    } else {
      // Default system browser
      if (platform === "win32" || wsl) {
        await $`cmd.exe /c start ${url}`.quiet();
      } else if (platform === "darwin") {
        await $`open ${url}`.quiet();
      } else {
        await $`xdg-open ${url}`.quiet();
      }
    }
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
