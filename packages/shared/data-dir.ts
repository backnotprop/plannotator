/**
 * Base directory for all Plannotator data. Priority: PLANNOTATOR_DATA_DIR (~ expanded); ~/.plannotator when it exists, unless it is a stray folder holding none of Plannotator's data (DATA_DIR_MARKERS) while $XDG_DATA_HOME/plannotator does; $XDG_DATA_HOME/plannotator when it is a non-empty absolute path; else ~/.plannotator.
 * Mirrored, and must stay identical, in apps/hook/hooks/mod/launch.ts `dataDirOf`, apps/amp-plugin/plannotator.ts and the install scripts; tests/data-dir-mirrors.test.ts runs the copies it can.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";

export function getPlannotatorDataDir(): string {
  const home = homedir();

  const envDir = process.env.PLANNOTATOR_DATA_DIR?.trim();
  if (envDir) {
    if (envDir === "~") return home;
    if (envDir.startsWith("~/") || envDir.startsWith("~\\")) {
      return join(home, envDir.slice(2));
    }
    return resolve(envDir);
  }

  return getDefaultPlannotatorDataDir(home);
}

/** Entries only Plannotator itself writes in real use. Entries an agent was told to make (`hooks/`, `plans/` reports, `config.json`) are deliberately absent. Mirrored in the mod, the Amp plugin and the install scripts. */
export const DATA_DIR_MARKERS = [
  "history",
  "sessions",
  "drafts",
  "inbox",
  "claude-code-mod",
  "install-flags.json",
] as const;

export function holdsPlannotatorData(dir: string): boolean {
  return DATA_DIR_MARKERS.some((entry) => existsSync(join(dir, entry)));
}

function xdgPlannotatorDataDir(): string | null {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  return xdgDataHome && isAbsolute(xdgDataHome) ? join(xdgDataHome, "plannotator") : null;
}

/** Tests and dev scripts compare against it to refuse the person's real data directory (tests/helpers/real-data-dir.ts). */
export function getDefaultPlannotatorDataDir(home: string = homedir()): string {
  const legacyDir = join(home, ".plannotator");
  const xdgDir = xdgPlannotatorDataDir();

  if (existsSync(legacyDir)) {
    // A stray ~/.plannotator never hides an XDG folder that holds the data. The XDG folder's existence is checked first; the markers are probed only when both folders exist.
    if (xdgDir && existsSync(xdgDir) && holdsPlannotatorData(xdgDir) && !holdsPlannotatorData(legacyDir)) {
      return xdgDir;
    }
    return legacyDir;
  }

  return xdgDir ?? legacyDir;
}

export function getUnusedPlannotatorDataDir(home: string = homedir()): string | null {
  if (process.env.PLANNOTATOR_DATA_DIR?.trim()) return null;
  const legacyDir = join(home, ".plannotator");
  const xdgDir = xdgPlannotatorDataDir();
  if (!xdgDir || !existsSync(legacyDir) || !existsSync(xdgDir)) return null;
  return getDefaultPlannotatorDataDir(home) === legacyDir ? xdgDir : legacyDir;
}
