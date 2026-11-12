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

export function getDefaultPlannotatorDataDir(home: string = homedir()): string {
  const legacyDir = join(home, ".plannotator");
  const xdgDir = xdgPlannotatorDataDir();

  if (existsSync(legacyDir)) {
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
