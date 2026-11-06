/**
 * "Another folder on <machine>…" (remote launch, approval addendum): the folders a person may start an agent in
 * besides their projects. Only under that machine's home folder, never a hidden one, and only folder names, one
 * level at a time: no files, no file contents, no sizes or dates.
 *
 * A typed path is `~`, `~/…`, or a full path inside home. A segment that is empty from a doubled slash is skipped;
 * `.` or `..` (anything that would step out), a path outside home, or a symlink whose target is outside home is
 * `outside`; a segment that starts with a dot is `hidden`. A path that isn't there (or is a file) is
 * `{ exists: false }`, which the window says plainly.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

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
  if (segments.some((segment) => segment === "." || segment === "..")) return { ok: false, refused: "outside" };
  if (segments.some((segment) => segment.startsWith("."))) return { ok: false, refused: "hidden" };
  const shown = segments.length === 0 ? "~" : `~/${segments.join("/")}`;
  const real = realOr(join(home, ...segments));
  if (real === null) return { ok: true, exists: false, real: null, shown };
  if (!inside(real, realHome)) return { ok: false, refused: "outside" };
  let folder = false;
  try {
    folder = statSync(real).isDirectory();
  } catch {
    folder = false;
  }
  return folder ? { ok: true, exists: true, real, shown } : { ok: true, exists: false, real: null, shown };
}

/** The folder names directly in a typed folder under home (hidden ones and links out of home left out). */
export function listHomeFolders(home: string, typed: string): { path: string; exists: boolean; folders: string[] } | { refused: HomeFolderRefusal } {
  const at = resolveHomeFolder(home, typed);
  if (!at.ok) return { refused: at.refused };
  if (!at.exists || !at.real) return { path: at.shown, exists: false, folders: [] };
  const realHome = realOr(home) ?? home;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(at.real, { withFileTypes: true });
  } catch {
    return { path: at.shown, exists: false, folders: [] };
  }
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) folders.push(entry.name);
    else if (entry.isSymbolicLink()) {
      const real = realOr(join(at.real, entry.name));
      if (real && inside(real, realHome) && statSync(real, { throwIfNoEntry: false })?.isDirectory()) folders.push(entry.name);
    }
  }
  folders.sort((a, b) => a.localeCompare(b));
  return { path: at.shown, exists: true, folders: folders.slice(0, HOME_FOLDERS_MAX) };
}
