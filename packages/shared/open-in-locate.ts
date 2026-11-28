/**
 * Where a catalog app is installed on this computer: the one answer both the
 * "is it installed" check (GET /api/open-in/apps) and the launch use, in both
 * server runtimes (Bun: packages/server/open-in.ts, Pi:
 * apps/pi-extension/server/open-in-apps.ts, vendored to generated/).
 *
 * The runtime-specific parts (PATH lookup, the filesystem) come in as `deps`
 * so each runtime keeps its own PATH resolution and tests can stub every one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPEN_IN_WIN_INSTALL_ROOTS,
  isWindowsExePath,
  openInCandidateNames,
  type OpenInApp,
  type OpenInPlatform,
} from "@plannotator/core/open-in-apps";

export interface OpenInLocateDeps {
  platform: OpenInPlatform;
  /** The absolute path `bin` resolves to on PATH, or null. */
  which: (bin: string) => string | null;
  exists?: (p: string) => boolean;
  /** Folder names directly inside `dir` (empty when it cannot be read). */
  listDirs?: (dir: string) => string[];
  env?: Record<string, string | undefined>;
  home?: string;
}

function defaultExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function defaultListDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** The standard macOS application folders a bundle is looked for in. */
export function macAppFolders(home: string): string[] {
  return [
    "/Applications",
    path.posix.join(home, "Applications"),
    "/System/Applications",
    // Terminal.app and other built-ins live in the Utilities subfolder.
    "/System/Applications/Utilities",
  ];
}

/**
 * What to launch for `app` here, or null when it is not installed:
 *  - mac: the bundle name to hand `open -a` (the first of `appName`, `also` found);
 *  - win/linux: the binary to spawn. An `exeOnly` app on Windows answers the
 *    absolute path of a real `.exe` (on PATH, else in an install folder), never
 *    a `.cmd`/`.bat`; other apps answer their catalog name, as before.
 */
export function locateOpenInApp(app: OpenInApp, deps: OpenInLocateDeps): string | null {
  const exists = deps.exists ?? defaultExists;
  const names = openInCandidateNames(app, deps.platform);
  if (names.length === 0) return null;

  if (deps.platform === "mac") {
    const folders = macAppFolders(deps.home ?? os.homedir());
    for (const name of names) {
      if (folders.some((dir) => exists(path.posix.join(dir, `${name}.app`)))) return name;
    }
    return null;
  }

  if (deps.platform === "win" && app.win?.exeOnly) {
    for (const name of names) {
      if (!isWindowsExePath(name)) continue;
      const found = deps.which(name);
      if (found && isWindowsExePath(found)) return found;
    }
    const env = deps.env ?? process.env;
    const listDirs = deps.listDirs ?? defaultListDirs;
    for (const root of OPEN_IN_WIN_INSTALL_ROOTS) {
      const base = env[root.env];
      if (!base) continue;
      const parent = path.win32.join(base, root.sub);
      for (const folder of listDirs(parent)) {
        for (const name of names) {
          if (!isWindowsExePath(name)) continue;
          const candidate = path.win32.join(parent, folder, "bin", name);
          if (exists(candidate)) return candidate;
        }
      }
    }
    return null;
  }

  for (const name of names) {
    if (deps.which(name)) return name;
  }
  return null;
}
