/**
 * Cross-platform browser opening utility
 */

import { $ } from "bun";
import os from "node:os";

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
    const browser = process.env.PLANNOTATOR_BROWSER;
    const platform = process.platform;
    const wsl = await isWSL();

    if (browser) {
      // Custom browser specified
      if (platform === "darwin") {
        await $`open -a ${browser} ${url}`.quiet();
      } else if (platform === "win32" || wsl) {
        await $`cmd.exe /c start "" ${browser} ${url}`.quiet();
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
    return false;
  }
}
