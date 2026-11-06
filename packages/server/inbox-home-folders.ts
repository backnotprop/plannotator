/**
 * "Another folder on <machine>…" (remote launch, approval addendum): the folders a person may start an agent in
 * besides their projects. Only under that machine's home folder, never a hidden one, and only folder names, one
 * level at a time: no files, no file contents, no sizes or dates.
 *
 * A typed path is `~`, `~/…`, or a full path inside home. A segment that is empty from a doubled slash is skipped;
 * `.` or `..` (anything that would step out), a segment with a backslash or a NUL (a path separator to some file
 * calls), a path outside home, or a symlink whose target is outside home is `outside`; a segment that starts with a
 * dot is `hidden`, and so is a path whose real place under home is in a hidden folder (a symlink to `~/.ssh`). Home
 * itself resolves (its folders are listed) but is never a folder to start in (`isHomeItself`). A path that isn't
 * there (or is a file) is `{ exists: false }`, with the nearest folder above it that is (`nearest`), so the window
 * can offer what is there.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** At most this many names come back for one folder (alphabetical): the window filters as the person types. */
export const HOME_FOLDERS_MAX = 500;

export type HomeFolderRefusal = "outside" | "hidden";

/** A typed path under home: the real folder and how the window shows it (`~/…`), whether it is there, or why not. */
export type HomeFolder = { ok: true; exists: boolean; real: string | null; shown: string } | { ok: false; refused: HomeFolderRefusal };

const realOr = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const inside = (real: string, realHome: string) => real === realHome || real.startsWith(realHome.endsWith(sep) ? realHome : `${realHome}${sep}`);

/** A real path under the real home that passes through a hidden folder (by where it really is, not how it was typed). */
const hiddenUnder = (real: string, realHome: string) => relative(realHome, real).split(sep).some((segment) => segment.startsWith("."));

/** Home itself: listed, never started in. */
export function isHomeItself(home: string, real: string): boolean {
  return real === (realOr(home) ?? home);
}

/** Where a typed path is under `home`, by the rules above. */
export function resolveHomeFolder(home: string, typed: string): HomeFolder {
  const text = typed.trim();
  const realHome = realOr(home) ?? home;
  let rest: string;
  if (text === "~" || text === "") rest = "";
  else if (text.startsWith("~/")) rest = text.slice(2);
  else if (isAbsolute(text) && (text === home || text.startsWith(`${home}/`))) rest = text.slice(home.length);
  else if (isAbsolute(text) && (text === realHome || text.startsWith(`${realHome}/`))) rest = text.slice(realHome.length);
  else return { ok: false, refused: "outside" };
  const segments = rest.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) return { ok: false, refused: "outside" };
  if (segments.some((segment) => segment.startsWith("."))) return { ok: false, refused: "hidden" };
  const shown = segments.length === 0 ? "~" : `~/${segments.join("/")}`;
  const real = realOr(join(home, ...segments));
  if (real === null) return { ok: true, exists: false, real: null, shown };
  if (!inside(real, realHome)) return { ok: false, refused: "outside" };
  if (hiddenUnder(real, realHome)) return { ok: false, refused: "hidden" };
  let folder = false;
  try {
    folder = statSync(real).isDirectory();
  } catch {
    folder = false;
  }
  return folder ? { ok: true, exists: true, real, shown } : { ok: true, exists: false, real: null, shown };
}

/** The folder names in a real folder under home: no hidden ones, none a typed path could not name, no links out of home or into a hidden folder. */
function foldersIn(real: string, realHome: string): string[] | null {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(real, { withFileTypes: true });
  } catch {
    return null;
  }
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.includes("\\")) continue;
    if (entry.isDirectory()) folders.push(entry.name);
    else if (entry.isSymbolicLink()) {
      const target = realOr(join(real, entry.name));
      if (target && inside(target, realHome) && !hiddenUnder(target, realHome) && statSync(target, { throwIfNoEntry: false })?.isDirectory()) folders.push(entry.name);
    }
  }
  folders.sort((a, b) => a.localeCompare(b));
  return folders.slice(0, HOME_FOLDERS_MAX);
}

/** A typed folder that isn't there: the nearest folder above it that is, and its folders (home at the latest). */
function nearestAbove(home: string, shown: string, realHome: string): { path: string; folders: string[] } | null {
  const segments = shown === "~" ? [] : shown.slice(2).split("/");
  for (let n = segments.length - 1; n >= 0; n--) {
    const up = resolveHomeFolder(home, n === 0 ? "~" : `~/${segments.slice(0, n).join("/")}`);
    if (!up.ok) return null;
    if (!up.exists || !up.real) continue;
    const folders = foldersIn(up.real, realHome);
    return folders ? { path: up.shown, folders } : null;
  }
  return null;
}

/**
 * The folder names directly in a typed folder under home (hidden ones and links out of home left out). A folder that
 * isn't there comes back `exists: false` with `nearest`: the nearest folder above it that is, and its folders.
 */
export function listHomeFolders(
  home: string,
  typed: string,
): { path: string; exists: boolean; folders: string[]; nearest?: { path: string; folders: string[] } } | { refused: HomeFolderRefusal } {
  const at = resolveHomeFolder(home, typed);
  if (!at.ok) return { refused: at.refused };
  const realHome = realOr(home) ?? home;
  const folders = at.exists && at.real ? foldersIn(at.real, realHome) : null;
  if (folders) return { path: at.shown, exists: true, folders };
  const nearest = nearestAbove(home, at.shown, realHome);
  return { path: at.shown, exists: false, folders: [], ...(nearest ? { nearest } : {}) };
}
