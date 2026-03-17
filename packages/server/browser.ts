/**
 * Cross-platform browser opening utility
 */

import { $ } from "bun";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const IPC_REGISTRY = path.join(os.homedir(), ".plannotator", "vscode-ipc.json");

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
async function isWSL(): Promise<boolean> {
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
export async function openBrowser(url: string): Promise<boolean> {
  try {
    const browser = process.env.PLANNOTATOR_BROWSER || process.env.BROWSER;
    const platform = process.platform;
    const wsl = await isWSL();

    if (browser) {
      const plannotatorBrowser = process.env.PLANNOTATOR_BROWSER;
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
