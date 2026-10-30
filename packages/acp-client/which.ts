/**
 * Finding an agent's program. Kept apart so the agent table, the spawn plan
 * and the client share one lookup. A host with its own idea of PATH passes its
 * own `find` instead.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Directories GUI-launched editors often miss on PATH (macOS Dock launches). */
function extraSearchDirs(): string[] {
  const home = homedir();
  if (process.platform === "win32") return [];
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin")];
}

/** The absolute path of an executable on PATH (plus the usual extra dirs), or null. */
export function findExecutable(name: string, env: Record<string, string | undefined> = process.env): string | null {
  if (isAbsolute(name)) return isExecutableFile(name) ? name : null;
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...extraSearchDirs()];
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** PATH with the extra dirs appended, for child processes. */
export function augmentedPath(env: Record<string, string | undefined> = process.env): string {
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of extraSearchDirs()) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}
