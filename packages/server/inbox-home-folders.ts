/**
 * "Another folder on <machine>…" (remote launch, approval addendum): the folders a person may start an agent in
 * besides their projects. Only under that machine's home folder, never a hidden one, and only folder names, one
 * level at a time: no files, no file contents, no sizes or dates.
 *
 * A typed path is `~`, `~/…`, or a full path inside home. A segment that is empty from a doubled slash is skipped;
 * `.` or `..` (anything that would step out), a segment with a backslash or a NUL (a path separator to some file
 * calls), a path outside home, or a symlink whose target is outside home is `outside`; a segment that starts with a
 * dot is `hidden`, and so is a path whose real place under home is in a hidden folder (a symlink to `~/.ssh`); a path
 * that isn't there is judged by its nearest folder that is, so it never tells what a hidden folder holds. Home
 * itself resolves (its folders are listed) but is never a folder to start in (`isHomeItself`). A path that isn't
 * there (or is a file) is `{ exists: false }`, with the nearest folder above it that is (`nearest`), so the window
 * can offer what is there.
 */
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** At most this many names come back for one folder (alphabetical): the window filters as the person types. */
export const HOME_FOLDERS_MAX = 500;

export type HomeFolderRefusal = "outside" | "hidden";

/**
 * What a typed path is (approval "launch-create-clone", A7-A10): a folder that can be opened, a folder that can't
 * (`locked`: no permission to read or enter it), a file, or nothing (`missing`).
 */
export type HomeFolderState = "folder" | "locked" | "file" | "missing";

/**
 * A typed path under home: the real folder and how the window shows it (`~/…`), whether it is there, or why not.
 * `exists` is a folder that can be opened (`state: "folder"`). A missing path under a file or a locked folder says
 * which (`blocked`): what stops it is that, not a typo.
 */
export type HomeFolder =
  | { ok: true; exists: boolean; state: HomeFolderState; real: string | null; shown: string; blocked?: { shown: string; state: "file" | "locked" } }
  | { ok: false; refused: HomeFolderRefusal };

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

/** A folder this process can read and enter (list and start in). */
const canOpen = (real: string) => {
  try {
    accessSync(real, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** A folder this process can make a folder in. */
const canWrite = (real: string) => {
  try {
    accessSync(real, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const isDir = (real: string) => statSync(real, { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * A folder that is there but can't be resolved (some systems can't take the real path of a folder with no permission
 * at all): its real parent and its own name, when it is a plain folder there (never a link, which can't be followed).
 */
function lockedAt(home: string, segments: string[]): string | null {
  if (segments.length === 0) return null;
  const parent = realOr(join(home, ...segments.slice(0, -1)));
  if (parent === null) return null;
  const path = join(parent, segments[segments.length - 1]!);
  try {
    return lstatSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

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
  const real = realOr(join(home, ...segments)) ?? lockedAt(home, segments);
  if (real === null) {
    // Not there: answer as its nearest folder that is, so a missing path never tells what a hidden folder, or one
    // outside home, holds (`~/code/sshlink/nope` is hidden, as `~/code/sshlink/sub` is).
    for (let n = segments.length - 1; n >= 0; n--) {
      const above = realOr(join(home, ...segments.slice(0, n))) ?? lockedAt(home, segments.slice(0, n));
      if (above === null) continue;
      if (!inside(above, realHome)) return { ok: false, refused: "outside" };
      if (hiddenUnder(above, realHome)) return { ok: false, refused: "hidden" };
      // What stops the path there: a file in its way, or a folder that can't be opened (a typo is neither).
      const aboveShown = n === 0 ? "~" : `~/${segments.slice(0, n).join("/")}`;
      const blocked = !isDir(above) ? ("file" as const) : !canOpen(above) ? ("locked" as const) : null;
      return { ok: true, exists: false, state: "missing", real: null, shown, ...(blocked ? { blocked: { shown: aboveShown, state: blocked } } : {}) };
    }
    return { ok: true, exists: false, state: "missing", real: null, shown };
  }
  if (!inside(real, realHome)) return { ok: false, refused: "outside" };
  if (hiddenUnder(real, realHome)) return { ok: false, refused: "hidden" };
  if (!isDir(real)) return { ok: true, exists: false, state: "file", real: null, shown };
  if (!canOpen(real)) return { ok: true, exists: false, state: "locked", real: null, shown };
  return { ok: true, exists: true, state: "folder", real, shown };
}

/** The folder names in a real folder under home: no hidden ones, none a typed path could not name, no links out of home, into a hidden folder, or back to home. */
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
      // Not a link back to home itself: it would offer home as a folder to start in, which is refused.
      if (target && target !== realHome && inside(target, realHome) && !hiddenUnder(target, realHome) && statSync(target, { throwIfNoEntry: false })?.isDirectory()) folders.push(entry.name);
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

/** The answer of `GET /api/inbox/launch/folders` (see `listHomeFolders`). */
export type HomeFolderListing = {
  path: string;
  exists: boolean;
  state: HomeFolderState;
  folders: string[];
  /** Of `folders`, the ones that can't be opened (no permission): listed dimmed, never picked (A9). */
  locked?: string[];
  /** A folder can be made in it (Create, Clone into): absent unless it is a folder that is there. */
  writable?: boolean;
  nearest?: { path: string; folders: string[] };
  /** A missing path under a file or a folder that can't be opened: which, and its `~/…` path. */
  blocked?: { path: string; state: "file" | "locked" };
};

/**
 * The folder names directly in a typed folder under home (hidden ones and links out of home left out), which of them
 * can't be opened, and whether a folder can be made in it. Any other path (missing, a file, a folder that can't be
 * opened) comes back `exists: false` with its `state` and `nearest`: the nearest folder above it that is, and its folders.
 */
export function listHomeFolders(home: string, typed: string): HomeFolderListing | { refused: HomeFolderRefusal } {
  const at = resolveHomeFolder(home, typed);
  if (!at.ok) return { refused: at.refused };
  const realHome = realOr(home) ?? home;
  const folders = at.exists && at.real ? foldersIn(at.real, realHome) : null;
  if (folders && at.real) {
    const locked = folders.filter((name) => !canOpen(join(at.real!, name)));
    return { path: at.shown, exists: true, state: "folder", folders, ...(locked.length > 0 ? { locked } : {}), writable: canWrite(at.real) };
  }
  const nearest = nearestAbove(home, at.shown, realHome);
  return {
    path: at.shown,
    exists: false,
    state: at.state === "folder" ? "locked" : at.state,
    folders: [],
    ...(nearest ? { nearest } : {}),
    ...(at.blocked ? { blocked: { path: at.blocked.shown, state: at.blocked.state } } : {}),
  };
}

/** The most characters a new folder's name may have (most file systems' limit). */
const NEW_FOLDER_NAME_MAX = 255;

/** Why a new folder can't be made at a typed path: the code the Send answers and its words. */
export type NewHomeFolderRefusal = { code: "validation_error" | "folder_missing" | "folder_unavailable"; message: string };

/**
 * Create a folder (approval "launch-create-clone", decision 1a): a typed path whose last folder isn't there, in a
 * folder that is and can be written. Only the last folder is ever made (no `mkdir -p`); a name with `\` or `:` (or a
 * NUL), a hidden one, or one a file already has is refused, and so is any path the folder listing refuses. A folder
 * that is there by now is answered as it is (`made: false`), so a Send never fails because the person was right.
 */
export function checkNewHomeFolder(home: string, typed: string): { ok: true; real: string | null; parent: string; name: string; shown: string } | ({ ok: false } & NewHomeFolderRefusal) {
  const at = resolveHomeFolder(home, typed);
  if (!at.ok) return { ok: false, code: "validation_error", message: at.refused === "hidden" ? "Hidden folders can't be picked. Nothing was sent." : "Pick a folder inside the home folder. Nothing was sent." };
  if (at.state === "folder") return { ok: true, real: at.real, parent: "", name: "", shown: at.shown };
  if (at.state === "file") return { ok: false, code: "folder_unavailable", message: `There's already a file named ${at.shown.split("/").pop()}. Pick another name. Nothing was sent.` };
  if (at.state === "locked") return { ok: false, code: "folder_unavailable", message: `Can't open ${at.shown}: no permission. Nothing was sent.` };
  const segments = at.shown === "~" ? [] : at.shown.slice(2).split("/");
  const name = segments[segments.length - 1] ?? "";
  if (name === "" || /[\\:\0]/.test(name) || name.length > NEW_FOLDER_NAME_MAX) return { ok: false, code: "validation_error", message: "A folder name can't have \\ or :. Nothing was sent." };
  const parentShown = segments.length <= 1 ? "~" : `~/${segments.slice(0, -1).join("/")}`;
  const parent = resolveHomeFolder(home, parentShown);
  if (!parent.ok) return { ok: false, code: "validation_error", message: "Pick a folder inside the home folder. Nothing was sent." };
  if (parent.state !== "folder" || !parent.real) {
    if (parent.state === "locked") return { ok: false, code: "folder_unavailable", message: `Can't make a folder in ${parentShown}: no permission. Nothing was sent.` };
    return { ok: false, code: "folder_missing", message: `There's no ${parentShown}. Only the last folder in a path can be made. Nothing was sent.` };
  }
  if (!canWrite(parent.real)) return { ok: false, code: "folder_unavailable", message: `Can't make a folder in ${parentShown}: no permission. Nothing was sent.` };
  return { ok: true, real: null, parent: parent.real, name, shown: at.shown };
}

/**
 * Makes the folder `checkNewHomeFolder` allowed (one level, never its parents). The folder it made and its identity
 * (`<dev>:<ino>`, so only that folder is ever removed again), or the folder that is there by now (`made: false`).
 */
export function makeHomeFolder(parent: string, name: string): { real: string; made: boolean; inode: string } {
  const path = join(parent, name);
  let made = true;
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isDir(path)) throw error;
    made = false;
  }
  // Checked again now it is there: a real folder right in `parent` (a real path), never a link swapped in since the
  // checks that leads out of home or into a hidden folder.
  const real = realpathSync(path);
  if (lstatSync(path).isSymbolicLink() || real !== join(realpathSync(parent), name)) throw new Error(`${path} is not a folder in ${parent}`);
  return { real, made, inode: folderIdentity(real)! };
}

/**
 * A folder's identity, for removing only a folder the Inbox made: `<dev>:<ino>`, then `:<birth time ns>` where the file
 * system keeps one. An inode number alone can come back (ext4 hands a freed one to the next folder made), and a folder
 * the person made then would read as the Inbox's; its birth time tells them apart. Null when it is not there.
 */
export function folderIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.birthtimeNs > 0n ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/** Two identities are the same folder: device and inode, and the birth time when both have one (older records have none). */
export function sameFolderIdentity(now: string | null, recorded: string | null | undefined): boolean {
  if (!now || !recorded) return false;
  const [dev, ino, birth] = now.split(":");
  const [recDev, recIno, recBirth] = recorded.split(":");
  return dev === recDev && ino === recIno && (!birth || !recBirth || birth === recBirth);
}
