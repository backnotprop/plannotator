/**
 * "Another folder on <machine>…" (remote launch, approval addendum "existing folders"): the pure rules of the folder
 * browser (HomeFolderBrowser.tsx). The typed path is split into the folder whose names are read (`parent`) and the
 * start of a name being typed (`tail`); the names read are narrowed by that start. No React and no requests here.
 */

/** The path as the field starts: the home folder, ready for a name. */
export const HOME_FOLDER_START = '~/';

/**
 * A typed path as the server reads it (`~`, `~/…`, or a full path): a bare name ("code/x") is under home. Spaces at
 * either end are dropped; slashes inside are kept as typed (the server skips doubled ones).
 */
export function normalizeFolderPath(typed: string): string {
  const text = typed.trim();
  if (text === '' || text === '~') return HOME_FOLDER_START;
  if (text.startsWith('~/') || text.startsWith('/')) return text;
  return `~/${text}`;
}

/**
 * The folder to read and the name being typed: "~/code/bil" → `~/code` and "bil"; "~/code/billing-api/" →
 * `~/code/billing-api` and "". The home folder is `~`.
 */
export function splitFolderPath(typed: string): { parent: string; tail: string } {
  const path = normalizeFolderPath(typed);
  const at = path.lastIndexOf('/');
  const parent = path.slice(0, at).replace(/\/+$/, '');
  return { parent: parent === '' ? (path.startsWith('~') ? '~' : '/') : parent, tail: path.slice(at + 1) };
}

/** The names read that start with what is typed, case aside, in the order read (the server's, alphabetical). */
export function folderSuggestions(names: readonly string[], tail: string): string[] {
  const start = tail.toLowerCase();
  return names.filter((name) => name.toLowerCase().startsWith(start));
}

/** A name in a folder, as the field shows it: `~/code` + "billing-api" → `~/code/billing-api`. */
export function folderChild(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

/** The last name of a path: `~/code/billing-api/` → "billing-api". */
export function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** How many single-letter edits turn one name into another (case aside): how close a folder is to what was typed. */
export function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return row[y.length]!;
}

/** How many letters a name starts with as typed (case aside). */
function sharedStart(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/**
 * The names, the closest to what was typed first: the longest shared start, then the fewest letter edits ("biling-svc"
 * → billing-svc, "nope" → notes-local); ties keep their order (the server's, alphabetical).
 */
export function closestFirst(names: readonly string[], typed: string): string[] {
  if (typed === '') return [...names];
  const rank = new Map(names.map((name) => [name, [sharedStart(name, typed), editDistance(name, typed)] as const]));
  return [...names].sort((a, b) => rank.get(b)![0] - rank.get(a)![0] || rank.get(a)![1] - rank.get(b)![1]);
}

/**
 * The name typed one level below `above` in `path`: `~/cod/billing` under `~` → "cod". What the folders of the nearest
 * folder that is there are matched against. Empty when `path` is not under `above`.
 */
export function nameBelow(path: string, above: string): string {
  const start = above === '~' ? '~/' : `${above.replace(/\/+$/, '')}/`;
  if (!path.startsWith(start)) return '';
  return path.slice(start.length).split('/').find(Boolean) ?? '';
}

/**
 * A pasted path as the person meant it (approval "launch-create-clone", B1-B3), cleaned here because the server
 * refuses a backslash: one line, without the quotes around it, a `file://` URL decoded, and Terminal's escapes
 * (`Client\ Work`, `\(1\)`) read as the characters they escape. A full path in `home` reads as `~/…`.
 */
export function cleanPastedPath(text: string, home: string | null = null): string {
  let path = text.replace(/[\r\n]+/g, '').trim();
  if (/^(['"]).*\1$/.test(path)) path = path.slice(1, -1);
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(path.slice('file://'.length).replace(/^localhost(?=\/)/, ''));
    } catch {
      path = path.slice('file://'.length);
    }
  }
  path = path.replace(/\\(.)/g, '$1');
  return homeRelative(path, home);
}

/** A full path in `home` as `~/…` (home itself as `~/`); anything else as it is. */
export function homeRelative(path: string, home: string | null): string {
  if (!home) return path;
  const base = home.replace(/\/+$/, '');
  if (path === base || path === `${base}/`) return HOME_FOLDER_START;
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

/** Text that reads as a path, not words to find a project by (B4): `~/…`, `/…`, a quoted path, or a `file://` URL. */
export function looksLikePath(text: string): boolean {
  return /^(~\/|~$|\/|'\/|"\/|'~\/|"~\/|file:\/\/)/.test(text.trim());
}

/** What the folder listing answered for one path (`GET /api/inbox/launch/folders`), as the browser keeps it. */
export interface FolderRead {
  exists: boolean;
  /** Absent from an older Inbox: `exists` says folder or missing. */
  state?: 'folder' | 'locked' | 'file' | 'missing';
  folders: readonly string[];
  locked?: readonly string[];
  writable?: boolean;
  nearest?: { path: string; folders: readonly string[] } | null;
  blocked?: { path: string; state: 'file' | 'locked' } | null;
}

/** One row of the folder browser (approval "launch-create-clone", A1-A12). */
export type FolderRow =
  /** "Start in <name>": a folder that is there leads, so Enter never forces the person deeper. */
  | { kind: 'start'; path: string; name: string }
  /** "Create <name> and start": a name that isn't there. `quiet`: a folder still matches the name, so it waits last. */
  | { kind: 'create'; path: string; name: string; quiet: boolean }
  /** "Go to <path>": a typo one level up, fixed (A5). */
  | { kind: 'fix'; path: string; name: string; from: string }
  /** A folder to go into. */
  | { kind: 'folder'; path: string; name: string }
  /** A folder that can't be opened: dimmed, with a lock and "no access", never picked (A9). */
  | { kind: 'noaccess'; path: string; name: string }
  /** Clone into a folder that is there (C14, C15): "Clone <repo> here", into `path` (its repo name, or the next free one). */
  | { kind: 'cloneHere'; path: string; name: string; repo: string; taken: string | null }
  /** That folder holds a clone of the same repo already (C9): "Start in <name> · already cloned". */
  | { kind: 'cloneStart'; path: string; name: string }
  /** A name that isn't there becomes the clone's own folder (C15b). `quiet`: a folder still matches the name. */
  | { kind: 'cloneInto'; path: string; name: string; quiet: boolean };

/** Where a clone into one folder goes, as that machine answered (`GET /api/inbox/launch/clone`). */
export interface CloneTargetRead {
  /** The folder it was asked for, `~/…`. */
  into: string;
  path: string;
  name: string;
  state: 'clone' | 'already';
  taken: string | null;
  writable: boolean;
}

/** The browser's line (in place of or above the folders), its rows, and a quiet line after a row (`after.at`: its index). */
export interface FolderBrowserView {
  note: string | null;
  rows: FolderRow[];
  after: { at: number; text: string } | null;
}

/** How many folders a refusal or a missing path offers under its line. */
const NEAR_MAX = 4;

/** How many letters a typo may be off from a folder that is there and still be fixed in one Enter (A5). */
const FIX_MAX_EDITS = 2;

/** A name that can't be a new folder's: the server refuses `\` and `:` (and so would Finder). */
const BAD_NAME = /[\\:]/;

/** The browser's words for a refused read: the server's code, in the prototype's words. */
export function folderRefusalWords(code: string | null, message: string): string {
  if (code === 'folder_hidden') return "Hidden folders aren't offered.";
  if (code === 'folder_outside_home') return 'Only folders inside your home folder.';
  return message;
}

/**
 * What the folder browser shows for a typed path (approval "launch-create-clone", A1-A12; the rules: a folder that is
 * there always leads; a name that isn't there becomes a new folder, last and quiet while a folder still starts with
 * it; only the last folder in a path can be made). Pure: `read` is the listing of the typed path's parent (null: not
 * read yet), `nameRead` the listing of the full path when the name typed is no folder read there (null: not read yet).
 */
export function folderBrowserView(input: {
  typed: string;
  read: FolderRead | null;
  nameRead: FolderRead | null;
  error?: string | null;
  /**
   * Clone into another folder (C14-C15c): the repo's name, and where a clone into the folder that is there (`cloneAt`)
   * goes (null: not read yet). A folder that is there is where the clone goes, never a stop on the way down; home too.
   */
  clone?: { repo: string; target: CloneTargetRead | null } | null;
}): FolderBrowserView {
  const view: FolderBrowserView = { note: null, rows: [], after: null };
  const clone = input.clone ?? null;
  /** The clone's lead into a folder that is there: Clone here, Start in (already cloned), or the line that it can't be written. */
  const cloneLead = (at: string): void => {
    const target = clone?.target;
    if (!target || target.into !== at) return;
    if (target.state === 'already') view.rows.push({ kind: 'cloneStart', path: target.path, name: target.name });
    else if (!target.writable) view.note = `Can't clone into ${at}: no permission.`;
    else view.rows.push({ kind: 'cloneHere', path: target.path, name: target.name, repo: clone!.repo, taken: target.taken });
  };
  const path = normalizeFolderPath(input.typed);
  const { parent, tail } = splitFolderPath(path);
  if (!parent.startsWith('~')) return { ...view, note: 'Only folders inside your home folder.' };
  if ([...parent.split('/').slice(1), tail].some((segment) => segment.startsWith('.'))) return { ...view, note: "Hidden folders aren't offered." };
  if (input.error) return { ...view, note: input.error };
  const read = input.read;
  if (!read) return view;
  const child = (base: string, name: string) => folderChild(base, name);
  const state = read.state ?? (read.exists ? 'folder' : 'missing');
  if (state === 'folder') {
    const locked = new Set(read.locked ?? []);
    const open = read.folders.filter((name) => !locked.has(name));
    const row = (name: string): FolderRow => (locked.has(name) ? { kind: 'noaccess', name, path: child(parent, name) } : { kind: 'folder', name, path: child(parent, name) });
    const names = folderSuggestions(read.folders, tail);
    const near = (n: number) => closestFirst(open, tail).slice(0, n).map(row);
    if (tail === '') {
      // Home itself is never started in (A1): its first folder leads instead. A clone may go in home.
      if (clone) cloneLead(parent);
      else if (parent !== '~') view.rows.push({ kind: 'start', path: parent, name: folderName(parent) });
      view.rows.push(...names.map(row));
      if (view.rows.length === 0) view.note = `${parent} has no folders.`;
      return view;
    }
    const exact = read.folders.includes(tail) ? tail : null;
    const typedPath = child(parent, tail);
    if (exact) {
      if (locked.has(exact)) view.note = `Can't open ${typedPath}: no permission.`;
      else if (clone) cloneLead(typedPath);
      else view.rows.push({ kind: 'start', path: typedPath, name: tail });
      view.rows.push(...names.map(row));
      return view;
    }
    const named = input.nameRead ? (input.nameRead.state ?? (input.nameRead.exists ? 'folder' : 'missing')) : null;
    if (named === 'folder') {
      // A folder the listing spells another way (a case-blind disk): it is there, so it leads.
      if (clone) cloneLead(typedPath);
      else view.rows.push({ kind: 'start', path: typedPath, name: tail });
      view.rows.push(...names.map(row));
      return view;
    }
    if (named === 'locked') {
      view.note = `Can't open ${typedPath}: no permission.`;
      return view;
    }
    if (named === 'file') {
      // A path to a file (A7): its folder leads. A name a file has (A8): pick another.
      if (/\.\w+$/.test(tail) && parent !== '~' && !clone) {
        view.note = `${tail} is a file.`;
        view.rows.push({ kind: 'start', path: parent, name: folderName(parent) });
      } else view.note = `There's already a file named ${tail}. Pick another name.`;
      view.rows.push(...near(NEAR_MAX));
      return view;
    }
    view.rows.push(...names.map(row));
    if (read.writable === false) {
      view.note = clone ? `Can't clone into ${parent}: no permission.` : `Can't make a folder in ${parent}: no permission.`;
      if (names.length === 0) view.rows.push(...near(NEAR_MAX));
      return view;
    }
    if (BAD_NAME.test(tail)) {
      view.note = "A folder name can't have \\ or :.";
      return view;
    }
    // Not checked yet: no Create row until the name is known not to be a file's.
    if (named === null) return view;
    const create: FolderRow = clone ? { kind: 'cloneInto', name: tail, path: typedPath, quiet: names.length > 0 } : { kind: 'create', name: tail, path: typedPath, quiet: names.length > 0 };
    if (names.length > 0) {
      view.rows.push(create);
      return view;
    }
    const others = near(NEAR_MAX);
    view.rows.unshift(create);
    if (others.length > 0 && !clone) view.after = { at: 1, text: "A new, empty folder. Or pick one that's there:" };
    view.rows.push(...others);
    return view;
  }
  if (state === 'locked') return { ...view, note: `Can't open ${parent}: no permission.` };
  const nearest = read.nearest ?? null;
  const nearRows = (base: string, names: readonly string[], typedName: string, from = 0, n = NEAR_MAX): FolderRow[] =>
    closestFirst(names, typedName)
      .slice(from, from + n)
      .map((name) => ({ kind: 'folder' as const, name, path: child(base, name) }));
  if (state === 'file') {
    // A file in the middle of the path (~/code/notes.md/x): its folder leads (never home).
    view.note = `${folderName(parent)} is a file.`;
    if (nearest) {
      if (nearest.path !== '~' && !clone) view.rows.push({ kind: 'start', path: nearest.path, name: folderName(nearest.path) });
      view.rows.push(...nearRows(nearest.path, nearest.folders, folderName(parent), 0, 3));
    }
    return view;
  }
  // Missing.
  if (read.blocked) return { ...view, note: read.blocked.state === 'file' ? `${read.blocked.path} is a file.` : `Can't open ${read.blocked.path}: no permission.` };
  if (!nearest) return { ...view, note: `There's no ${parent}.` };
  const wrong = nameBelow(parent, nearest.path);
  const bad = folderChild(nearest.path, wrong);
  const best = closestFirst(nearest.folders, wrong)[0];
  if (best && wrong && editDistance(best, wrong) <= FIX_MAX_EDITS) {
    // A typo one level up (A5): one Enter goes to the path as meant, then Enter again creates.
    const rest = parent.slice(bad.length);
    view.note = `There's no ${bad}.`;
    view.rows.push({ kind: 'fix', path: `${folderChild(nearest.path, best)}${rest}/${tail}`, name: best, from: wrong });
    view.rows.push(...nearRows(nearest.path, nearest.folders, wrong, 1, NEAR_MAX - 1));
    return view;
  }
  view.note = `There's no ${bad}. Only the last folder in a path can be made.`;
  view.rows.push(...nearRows(nearest.path, nearest.folders, wrong));
  return view;
}

/** Whether the browser needs the full path read: a name typed in a folder that is there, which is none of its folders. */
export function needsNameRead(read: FolderRead | null, tail: string): boolean {
  if (!read || tail === '' || tail.startsWith('.')) return false;
  const state = read.state ?? (read.exists ? 'folder' : 'missing');
  return state === 'folder' && !read.folders.includes(tail);
}

/**
 * Clone into another folder: the folder that is there that the typed path names (where "Clone <repo> here" clones
 * into), or null while the path names none (a new name, a file, a folder that can't be opened, not read yet).
 */
export function cloneAt(typed: string, read: FolderRead | null, nameRead: FolderRead | null): string | null {
  if (!read) return null;
  const { parent, tail } = splitFolderPath(normalizeFolderPath(typed));
  const state = read.state ?? (read.exists ? 'folder' : 'missing');
  if (state !== 'folder') return null;
  if (tail === '') return parent;
  if (tail.startsWith('.')) return null;
  const locked = new Set(read.locked ?? []);
  if (read.folders.includes(tail)) return locked.has(tail) ? null : folderChild(parent, tail);
  const named = nameRead ? (nameRead.state ?? (nameRead.exists ? 'folder' : 'missing')) : null;
  return named === 'folder' ? folderChild(parent, tail) : null;
}
