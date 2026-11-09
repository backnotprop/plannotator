/**
 * "Another folder on <machine>…" (remote launch, approval addendum; approval "inbox-launch-any-folder"): the folders a
 * person may start an agent in besides their projects. Any folder on that machine except a system one or a hidden one,
 * so a folder on another drive (`/Volumes/…`, `/mnt/…`, `/media/…`) works too. Only folder names, one level at a time:
 * no files, no file contents, no sizes or dates.
 *
 * A typed path is `~`, `~/…`, or a full path. A path in home reads as `~/…`; any other is shown as its full path. A
 * segment that is empty from a doubled slash is skipped; `.` or `..`, a segment with a backslash or a NUL (a path
 * separator to some file calls), or a path that is neither is `outside`; a segment that starts with a dot is `hidden`,
 * and so is a path whose real place is in a hidden folder (a symlink to `~/.ssh`); a path whose real place is under a
 * system folder (`/System`, `/usr`, `/private`, `/etc`, … by platform: `folderPlacesFor`) is `system`. A path that
 * isn't there is judged by its nearest folder that is, so it never tells what a hidden or system folder holds.
 *
 * Some folders are listed but never started in (`start: false`): home itself, any folder above home, `/`, and the
 * folders drives are mounted in (`/Volumes`, `/mnt`, `/media`): an agent there would reach every folder under them,
 * hidden ones too. A drive's own root (`/Volumes/Studio SSD`) can be started in. A path that isn't there (or is a file)
 * is `{ exists: false }`, with the nearest folder above it that is (`nearest`), so the window can offer what is there.
 *
 * This file imports only `node:fs` and `node:path`: its own source runs in a child process for a folder outside home
 * (`inbox-folder-reader.ts`), so a drive that doesn't answer never stops the Inbox.
 */
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { windowsFolderHidden, windowsTypedUnderHome } from "./inbox-launch-windows";

/** At most this many names come back for one folder (alphabetical): the window filters as the person types. */
export const HOME_FOLDERS_MAX = 500;

export type HomeFolderRefusal = "outside" | "hidden" | "system";

/**
 * Where a machine keeps its own files and its drives. `system`: never listed, never started in (nor anything under
 * them), except under `open`. `containers`: listed, never started in (the folders drives are mounted in, and `/`).
 */
export interface FolderPlaces {
  system: readonly string[];
  open: readonly string[];
  containers: readonly string[];
}

/** The system folders and drive folders of a platform. */
export function folderPlacesFor(platform: string): FolderPlaces {
  if (platform === "darwin") {
    return {
      system: ["/System", "/Library", "/Applications", "/bin", "/sbin", "/usr", "/private", "/etc", "/var", "/tmp", "/dev", "/cores", "/opt", "/Network", "/net", "/home"],
      open: [],
      containers: ["/", "/Volumes", "/Users"],
    };
  }
  return {
    system: ["/proc", "/sys", "/dev", "/boot", "/efi", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/var", "/run", "/root", "/snap", "/tmp", "/lost+found", "/opt"],
    // Removable drives on Fedora and Arch mount under /run/media/<user>.
    open: ["/run/media"],
    containers: ["/", "/home", "/mnt", "/media", "/run/media"],
  };
}

const defaultPlaces = (): FolderPlaces => folderPlacesFor(process.platform);

/**
 * What a typed path is (approval "launch-create-clone", A7-A10): a folder that can be opened, a folder that can't
 * (`locked`: no permission to read or enter it), a file, or nothing (`missing`).
 */
export type HomeFolderState = "folder" | "locked" | "file" | "missing";

/**
 * A typed path: the real folder and how the window shows it (`~/…` in home, else the full path), whether it is there,
 * or why not. `exists` is a folder that can be opened (`state: "folder"`). `start`: it can be started in (not home,
 * a folder above it, `/` or a drives folder). A missing path under a file or a locked folder says which (`blocked`).
 */
export type HomeFolder =
  | { ok: true; exists: boolean; state: HomeFolderState; real: string | null; shown: string; start: boolean; blocked?: { shown: string; state: "file" | "locked" } }
  | { ok: false; refused: HomeFolderRefusal };

const realOr = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** `path` is `root` or under it. */
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

const inside = (real: string, realHome: string) => under(real, realHome);

/**
 * A real path under the real home that passes through a hidden folder (by where it really is, not how it was typed).
 * On Windows a folder with the Hidden or System attribute is hidden too (AppData, the `Application Data` junctions).
 */
const hiddenUnder = (real: string, realHome: string) => {
  const segments = relative(realHome, real).split(sep).filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) return true;
  return process.platform === "win32" && segments.some((_, n) => windowsFolderHidden(join(realHome, ...segments.slice(0, n + 1))));
};

/**
 * Why a real folder is never offered (null: it may be), and whether it can be started in. In home: hidden folders are
 * refused, home itself is not started in. Elsewhere: a hidden folder anywhere on its path, or a system folder, is
 * refused; `/`, a drives folder and any folder above home are listed but not started in.
 */
function judge(real: string, realHome: string, places: FolderPlaces): { refused: HomeFolderRefusal | null; start: boolean } {
  if (inside(real, realHome)) return hiddenUnder(real, realHome) ? { refused: "hidden", start: false } : { refused: null, start: real !== realHome };
  const refused = refusedOutside(real, places);
  if (refused) return { refused, start: false };
  const above = realHome === real || under(realHome, real);
  return { refused: null, start: !above && !places.containers.includes(real) };
}

/** Why a real folder outside home is never offered, or null: hidden on the way down, or under a system folder. */
function refusedOutside(real: string, places: FolderPlaces): HomeFolderRefusal | null {
  if (real.split(sep).some((segment) => segment.startsWith("."))) return "hidden";
  if (places.system.some((root) => under(real, root)) && !places.open.some((root) => under(real, root))) return "system";
  return null;
}

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

/** Where a typed path's segments start: home (`~/…`) or the top of the disk (a full path outside home). */
type Base = { dir: string; tilde: boolean };

/** A path as the window shows it, from its base and segments: `~/code/x`, `~`, `/Volumes/Studio SSD`, `/`. */
const shownOf = (base: Base, segments: readonly string[]) => (base.tilde ? (segments.length === 0 ? "~" : `~/${segments.join("/")}`) : `/${segments.join("/")}`);

/** A shown path back into its base and segments (`shownOf`'s inverse). */
function baseOf(home: string, shown: string): { base: Base; segments: string[] } {
  if (shown === "~" || shown.startsWith("~/")) return { base: { dir: home, tilde: true }, segments: shown.slice(1).split("/").filter(Boolean) };
  return { base: { dir: "/", tilde: false }, segments: shown.split("/").filter(Boolean) };
}

/** The folder above a shown path (`~/code/x` → `~/code`, `/Volumes/A` → `/Volumes`, `~/x` → `~`, `/x` → `/`). */
export function shownParent(shown: string): string {
  const tilde = shown === "~" || shown.startsWith("~/");
  const segments = (tilde ? shown.slice(1) : shown).split("/").filter(Boolean);
  return shownOf({ dir: "", tilde }, segments.slice(0, -1));
}

/**
 * A folder that is there but can't be resolved (some systems can't take the real path of a folder with no permission
 * at all): its real parent and its own name, when it is a plain folder there (never a link, which can't be followed).
 */
function lockedAt(base: string, segments: string[]): string | null {
  if (segments.length === 0) return null;
  const parent = realOr(join(base, ...segments.slice(0, -1)));
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

/** A typed path read into its base and segments, or why it can't be one (before anything is read). */
function parseTyped(home: string, realHome: string, typed: string): { base: Base; segments: string[] } | { refused: HomeFolderRefusal } {
  let text = typed.trim();
  if (process.platform === "win32") {
    // `C:\Users\me\code`, `c:/users/me/code` or `~\code`: read as `~/code`. Another drive is outside home here.
    const underHome = windowsTypedUnderHome(text, home);
    if (underHome === null) return { refused: "outside" };
    text = underHome;
  }
  let base: Base;
  let rest: string;
  if (text === "~" || text === "") (base = { dir: home, tilde: true }), (rest = "");
  else if (text.startsWith("~/")) (base = { dir: home, tilde: true }), (rest = text.slice(2));
  else if (isAbsolute(text) && (text === home || text.startsWith(`${home}/`))) (base = { dir: home, tilde: true }), (rest = text.slice(home.length));
  else if (isAbsolute(text) && (text === realHome || text.startsWith(`${realHome}/`))) (base = { dir: home, tilde: true }), (rest = text.slice(realHome.length));
  else if (text.startsWith("/")) (base = { dir: "/", tilde: false }), (rest = text);
  else return { refused: "outside" };
  const segments = rest.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) return { refused: "outside" };
  if (segments.some((segment) => segment.startsWith("."))) return { refused: "hidden" };
  return { base, segments };
}

/** Where a typed path is, by the rules above. `places`: the machine's system and drives folders (tests name their own). */
export function resolveHomeFolder(home: string, typed: string, places: FolderPlaces = defaultPlaces()): HomeFolder {
  const text = typed.trim();
  const realHome = realOr(home) ?? home;
  const parsed = parseTyped(home, realHome, text);
  if ("refused" in parsed) return { ok: false, refused: parsed.refused };
  const { base, segments } = parsed;
  const shown = shownOf(base, segments);
  const real = realOr(join(base.dir, ...segments)) ?? lockedAt(base.dir, segments);
  if (real === null) {
    // Not there: answer as its nearest folder that is, so a missing path never tells what a hidden folder, or a system
    // one, holds (`~/code/sshlink/nope` is hidden, as `~/code/sshlink/sub` is).
    for (let n = segments.length - 1; n >= 0; n--) {
      const above = realOr(join(base.dir, ...segments.slice(0, n))) ?? lockedAt(base.dir, segments.slice(0, n));
      if (above === null) continue;
      const judged = judge(above, realHome, places);
      if (judged.refused) return { ok: false, refused: judged.refused };
      // What stops the path there: a file in its way, or a folder that can't be opened (a typo is neither).
      const aboveShown = shownOf(base, segments.slice(0, n));
      const blocked = !isDir(above) ? ("file" as const) : !canOpen(above) ? ("locked" as const) : null;
      return { ok: true, exists: false, state: "missing", real: null, shown, start: false, ...(blocked ? { blocked: { shown: aboveShown, state: blocked } } : {}) };
    }
    return { ok: true, exists: false, state: "missing", real: null, shown, start: false };
  }
  const judged = judge(real, realHome, places);
  if (judged.refused) return { ok: false, refused: judged.refused };
  if (!isDir(real)) return { ok: true, exists: false, state: "file", real: null, shown, start: false };
  if (!canOpen(real)) return { ok: true, exists: false, state: "locked", real: null, shown, start: false };
  return { ok: true, exists: true, state: "folder", real, shown, start: judged.start };
}

/**
 * The folder names in a real folder: no hidden ones, none a typed path could not name, no system folders, and no links
 * that land in a hidden or system folder or in one that is never started in (home, a folder above it, `/`). `nostart`:
 * of the names, the folders that are listed but never started in (a drives folder, a folder above home).
 */
function foldersIn(real: string, realHome: string, places: FolderPlaces): { folders: string[]; nostart: string[] } | null {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(real, { withFileTypes: true });
  } catch {
    return null;
  }
  const folders: string[] = [];
  const nostart: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.includes("\\")) continue;
    if (process.platform === "win32" && windowsFolderHidden(join(real, entry.name))) continue;
    if (entry.isDirectory()) {
      const judged = judge(join(real, entry.name), realHome, places);
      if (judged.refused) continue;
      folders.push(entry.name);
      if (!judged.start) nostart.push(entry.name);
    } else if (entry.isSymbolicLink()) {
      const target = realOr(join(real, entry.name));
      // Not a link to home itself, above it, or to `/` (`/Volumes/Macintosh HD`): it would offer a folder never started in.
      if (target && statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
        const judged = judge(target, realHome, places);
        if (!judged.refused && judged.start) folders.push(entry.name);
      }
    }
  }
  folders.sort((a, b) => a.localeCompare(b));
  const kept = folders.slice(0, HOME_FOLDERS_MAX);
  return { folders: kept, nostart: nostart.filter((name) => kept.includes(name)) };
}

/** A typed folder that isn't there: the nearest folder above it that is, and its folders (home, or `/`, at the latest). */
function nearestAbove(home: string, shown: string, realHome: string, places: FolderPlaces): { path: string; folders: string[] } | null {
  const { base, segments } = baseOf(home, shown);
  for (let n = segments.length - 1; n >= 0; n--) {
    const up = resolveHomeFolder(home, shownOf(base, segments.slice(0, n)), places);
    if (!up.ok) return null;
    if (!up.exists || !up.real) continue;
    const listed = foldersIn(up.real, realHome, places);
    return listed ? { path: up.shown, folders: listed.folders } : null;
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
  /** Of `folders`, the ones that are listed but never started in (a drives folder, a folder above home). */
  nostart?: string[];
  /** The folder itself is never started in (home, a folder above it, `/`, a drives folder): absent when it can be. */
  start?: false;
  /** A folder can be made in it (Create, Clone into): absent unless it is a folder that is there. */
  writable?: boolean;
  nearest?: { path: string; folders: string[] };
  /** A missing path under a file or a folder that can't be opened: which, and its shown path. */
  blocked?: { path: string; state: "file" | "locked" };
};

/**
 * The folder names directly in a typed folder (hidden and system ones and links to them left out), which of them
 * can't be opened or started in, and whether a folder can be made in it. Any other path (missing, a file, a folder
 * that can't be opened) comes back `exists: false` with its `state` and `nearest`: the nearest folder above it that
 * is, and its folders.
 */
export function listHomeFolders(home: string, typed: string, places: FolderPlaces = defaultPlaces()): HomeFolderListing | { refused: HomeFolderRefusal } {
  const at = resolveHomeFolder(home, typed, places);
  if (!at.ok) return { refused: at.refused };
  const realHome = realOr(home) ?? home;
  const listed = at.exists && at.real ? foldersIn(at.real, realHome, places) : null;
  if (listed && at.real) {
    const locked = listed.folders.filter((name) => !canOpen(join(at.real!, name)));
    return {
      path: at.shown,
      exists: true,
      state: "folder",
      folders: listed.folders,
      ...(locked.length > 0 ? { locked } : {}),
      ...(listed.nostart.length > 0 ? { nostart: listed.nostart } : {}),
      ...(at.start || at.shown === "~" ? {} : { start: false as const }),
      writable: canWrite(at.real),
    };
  }
  const nearest = nearestAbove(home, at.shown, realHome, places);
  return {
    path: at.shown,
    exists: false,
    state: at.state === "folder" ? "locked" : at.state,
    folders: [],
    ...(nearest ? { nearest } : {}),
    ...(at.blocked ? { blocked: { path: at.blocked.shown, state: at.blocked.state } } : {}),
  };
}

/** A refused path's words for a Send ("… Nothing was sent."). */
export function folderRefusalMessage(refused: HomeFolderRefusal): string {
  if (refused === "hidden") return "Hidden folders can't be picked. Nothing was sent.";
  if (refused === "system") return "System folders can't be picked. Nothing was sent.";
  return "Pick a folder by its full path. Nothing was sent.";
}

/** A folder that is listed but never started in, said for a Send (home's words as they always were). */
export function noStartMessage(shown: string): string {
  return shown === "~" ? "Pick a folder inside the home folder. Nothing was sent." : `Pick a folder inside ${shown}. Nothing was sent.`;
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
export function checkNewHomeFolder(
  home: string,
  typed: string,
  places: FolderPlaces = defaultPlaces(),
): { ok: true; real: string | null; parent: string; name: string; shown: string } | ({ ok: false } & NewHomeFolderRefusal) {
  const at = resolveHomeFolder(home, typed, places);
  if (!at.ok) return { ok: false, code: "validation_error", message: folderRefusalMessage(at.refused) };
  if (at.state === "folder") return { ok: true, real: at.real, parent: "", name: "", shown: at.shown };
  if (at.state === "file") return { ok: false, code: "folder_unavailable", message: `There's already a file named ${at.shown.split("/").pop()}. Pick another name. Nothing was sent.` };
  if (at.state === "locked") return { ok: false, code: "folder_unavailable", message: `Can't open ${at.shown}: no permission. Nothing was sent.` };
  const { segments } = baseOf(home, at.shown);
  const name = segments[segments.length - 1] ?? "";
  if (name === "" || /[\\:\0]/.test(name) || name.length > NEW_FOLDER_NAME_MAX) return { ok: false, code: "validation_error", message: "A folder name can't have \\ or :. Nothing was sent." };
  const parentShown = shownParent(at.shown);
  const parent = resolveHomeFolder(home, parentShown, places);
  if (!parent.ok) return { ok: false, code: "validation_error", message: folderRefusalMessage(parent.refused) };
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
  // checks that leads somewhere else or into a hidden folder.
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
