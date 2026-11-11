/** PATH in an environment copy, on every platform. Windows names the variable in any case and matches it case-insensitively, but a plain object copy of the environment holds both `Path` and `PATH` and the child may get the old one. */

export type EnvCopy = Record<string, string>;

export function pathDelimiterOf(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ";" : ":";
}

export function isPathName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH";
}

/** PATH's value in `env`: on Windows the last key that names it (a later copy wins, as in an object spread). */
export function envPathOf(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return env.PATH;
  let value: string | undefined;
  for (const [name, each] of Object.entries(env)) if (isPathName(name, platform) && each !== undefined) value = each;
  return value;
}

/** `env` with PATH under the one key `PATH` (Windows: every other spelling folded in, the last one's value kept). */
export function foldEnvPath<T extends Record<string, string | undefined>>(env: T, platform: NodeJS.Platform = process.platform): T {
  if (platform !== "win32") return env;
  const value = envPathOf(env, platform);
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => !isPathName(name, platform))) as T;
  if (value !== undefined) (out as Record<string, string | undefined>).PATH = value;
  return out;
}

export function withEnvPath<T extends Record<string, string | undefined>>(env: T, value: string, platform: NodeJS.Platform = process.platform): T {
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => !isPathName(name, platform))) as T;
  (out as Record<string, string | undefined>).PATH = value;
  return out;
}

export function pathFoldersOf(value: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  return (value ?? "").split(pathDelimiterOf(platform)).filter(Boolean);
}

/** `folders` as one PATH value: each once, first place kept (Windows: folders that differ only in case are one). */
export function joinPathFolders(folders: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const folder of folders) {
    if (!folder) continue;
    const key = platform === "win32" ? folder.replace(/[\\/]+$/, "").toLowerCase() : folder;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(folder);
  }
  return out.join(pathDelimiterOf(platform));
}
