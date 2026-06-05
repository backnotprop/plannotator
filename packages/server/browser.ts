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
  try {
    const rawPlannotatorBrowser = process.env.PLANNOTATOR_BROWSER;
    const rawBrowser = process.env.BROWSER;
    const plannotatorBrowser = isNoOpBrowserSentinel(rawPlannotatorBrowser)
      ? undefined
      : rawPlannotatorBrowser;
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

    if (browser) {
      if (plannotatorBrowser && platform === "darwin") {
        if (plannotatorBrowser.includes("/") && !plannotatorBrowser.endsWith(".app")) {
          await $`${plannotatorBrowser} ${url}`.quiet();
        } else {
          await $`open -a ${plannotatorBrowser} ${url}`.quiet();
        }
      } else if ((platform === "win32" || wsl) && plannotatorBrowser) {
        await $`cmd.exe /c start "" ${plannotatorBrowser} ${url}`.quiet();
      } else {
        await $`${browser} ${url}`.quiet();
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
  } catch {
    // Shell-based open failed — try VS Code IPC registry as fallback
    return tryVscodeIpc(url);
  }
}
