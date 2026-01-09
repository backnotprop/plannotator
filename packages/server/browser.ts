/**
 * Cross-platform browser opening utility
 */

import { $ } from "bun";

/**
 * Open a URL in the browser
 *
 * Uses PLANNOTATOR_BROWSER env var if set, otherwise uses system default.
 * - macOS: Set to app name ("Google Chrome") or path ("/Applications/Firefox.app")
 * - Linux/Windows: Set to executable path ("/usr/bin/firefox")
 *
 * Fails silently if browser can't be opened
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    const browser = process.env.PLANNOTATOR_BROWSER;
    const platform = process.platform;

    if (browser) {
      // Custom browser specified
      if (platform === "darwin") {
        await $`open -a ${browser} ${url}`.quiet();
      } else {
        await $`${browser} ${url}`.quiet();
      }
    } else {
      // Default system browser
      if (platform === "win32") {
        await $`cmd /c start ${url}`.quiet();
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
