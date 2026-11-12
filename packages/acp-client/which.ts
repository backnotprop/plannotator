import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

function extraSearchDirs(): string[] {
  const home = homedir();
  if (process.platform === "win32") return [];
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin")];
}

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

export function augmentedPath(env: Record<string, string | undefined> = process.env): string {
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of extraSearchDirs()) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}
