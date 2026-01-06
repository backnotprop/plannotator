/**
 * Cross-platform browser opening utility
 */

import { $ } from "bun";

/**
 * Open a URL in the default browser
 * Fails silently if browser can't be opened
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    const platform = process.platform;
    if (platform === "win32") {
      await $`cmd /c start ${url}`.quiet();
    } else if (platform === "darwin") {
      await $`open ${url}`.quiet();
    } else {
      await $`xdg-open ${url}`.quiet();
    }
    return true;
  } catch {
    return false;
  }
}
