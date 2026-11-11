export const HOME_FOLDER_START = '~/';

export function normalizeFolderPath(typed: string): string {
  const text = typed.trim();
  if (text === '' || text === '~') return HOME_FOLDER_START;
  if (text.startsWith('~/') || text.startsWith('/')) return text;
  return `~/${text}`;
}

export function splitFolderPath(typed: string): { parent: string; tail: string } {
  const path = normalizeFolderPath(typed);
  const at = path.lastIndexOf('/');
  const parent = path.slice(0, at).replace(/\/+$/, '');
  return { parent: parent === '' ? (path.startsWith('~') ? '~' : '/') : parent, tail: path.slice(at + 1) };
}

export function folderSuggestions(names: readonly string[], tail: string): string[] {
  const start = tail.toLowerCase();
  return names.filter((name) => name.toLowerCase().startsWith(start));
}

export function folderChild(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, '')}/${name}`;
}

export function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

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

function sharedStart(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

export function closestFirst(names: readonly string[], typed: string): string[] {
  if (typed === '') return [...names];
  const rank = new Map(names.map((name) => [name, [sharedStart(name, typed), editDistance(name, typed)] as const]));
  return [...names].sort((a, b) => rank.get(b)![0] - rank.get(a)![0] || rank.get(a)![1] - rank.get(b)![1]);
}

export function nameBelow(path: string, above: string): string {
  const start = above === '~' ? '~/' : `${above.replace(/\/+$/, '')}/`;
  if (!path.startsWith(start)) return '';
  return path.slice(start.length).split('/').find(Boolean) ?? '';
}

/** Text cleaned once already (`unescape: false`) keeps its backslashes, so `~/a\\b` never loses both. */
export function cleanPastedPath(text: string, home: string | null = null, { unescape = true }: { unescape?: boolean } = {}): string {
  let path = text.replace(/[\r\n]+/g, '').trim();
  if (/^(['"]).*\1$/.test(path)) path = path.slice(1, -1);
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(path.slice('file://'.length).replace(/^localhost(?=\/)/, ''));
    } catch {
      path = path.slice('file://'.length);
    }
  }
  if (unescape) path = path.replace(/\\(.)/g, '$1');
  return homeRelative(path, home);
}

export function homeRelative(path: string, home: string | null): string {
  if (!home) return path;
  const base = home.replace(/\/+$/, '');
  if (path === base || path === `${base}/`) return HOME_FOLDER_START;
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

export function looksLikePath(text: string): boolean {
  return /^(~\/|~$|\/|'\/|"\/|'~\/|"~\/|file:\/\/)/.test(text.trim());
}

export interface FolderRead {
  exists: boolean;
  state?: 'folder' | 'locked' | 'file' | 'missing';
  folders: readonly string[];
  locked?: readonly string[];
  writable?: boolean;
  nearest?: { path: string; folders: readonly string[] } | null;
  blocked?: { path: string; state: 'file' | 'locked' } | null;
  start?: false;
  nostart?: readonly string[];
}

export type FolderRow =
  | { kind: 'start'; path: string; name: string }
  | { kind: 'create'; path: string; name: string; quiet: boolean }
  | { kind: 'fix'; path: string; name: string; from: string }
  | { kind: 'folder'; path: string; name: string }
  | { kind: 'noaccess'; path: string; name: string }
  | { kind: 'cloneHere'; path: string; name: string; repo: string; taken: string | null }
  | { kind: 'cloneStart'; path: string; name: string }
  | { kind: 'cloneInto'; path: string; name: string; quiet: boolean };

export interface CloneTargetRead {
  into: string;
  path: string;
  name: string;
  state: 'clone' | 'already';
  taken: string | null;
  writable: boolean;
}

export interface FolderBrowserView {
  note: string | null;
  rows: FolderRow[];
  after: { at: number; text: string } | null;
}

const NEAR_MAX = 4;

const FIX_MAX_EDITS = 2;

/** The server refuses `\` and `:` in a new folder's name. */
const BAD_NAME = /[\\:]/;

export function folderRefusalWords(code: string | null, message: string): string {
  if (code === 'folder_hidden') return "Hidden folders aren't offered.";
  if (code === 'folder_system') return "System folders aren't offered.";
  if (code === 'folder_outside_home') return 'Only folders inside your home folder.';
  return message;
}

export interface FolderDrive {
  path: string;
  name: string;
  network?: true;
}

export function placeOf(path: string, drives: readonly FolderDrive[]): FolderDrive | null {
  const clean = path.replace(/\/+$/, '');
  return drives.filter((d) => clean === d.path || clean.startsWith(`${d.path}/`)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

export function unpluggedDrive(root: string, drives: readonly FolderDrive[] | null | undefined): string | null {
  if (!drives) return null;
  const parts = root.split('/').filter(Boolean);
  const at = parts[0] === 'Volumes' || parts[0] === 'mnt' ? 1 : parts[0] === 'run' && parts[1] === 'media' ? 3 : parts[0] === 'media' ? (parts.length > 3 ? 2 : 1) : -1;
  const name = at > 0 ? parts[at] : undefined;
  if (!name || placeOf(root, drives)) return null;
  return name;
}

export function drivePathOf(root: string, drives: readonly FolderDrive[] | null | undefined): { name: string; folders: string[] } | null {
  if (!drives) return null;
  const parts = root.split('/').filter(Boolean);
  const mounted = placeOf(root, drives);
  if (mounted) return { name: mounted.name, folders: parts.slice(mounted.path.split('/').filter(Boolean).length) };
  const name = unpluggedDrive(root, drives);
  if (!name) return null;
  return { name, folders: parts.slice(parts.indexOf(name) + 1) };
}

export function folderBrowserView(input: {
  typed: string;
  read: FolderRead | null;
  nameRead: FolderRead | null;
  error?: string | null;
  clone?: { repo: string; target: CloneTargetRead | null } | null;
}): FolderBrowserView {
  const view: FolderBrowserView = { note: null, rows: [], after: null };
  const clone = input.clone ?? null;
  const cloneLead = (at: string): void => {
    const target = clone?.target;
    if (!target || target.into !== at) return;
    if (target.state === 'already') view.rows.push({ kind: 'cloneStart', path: target.path, name: target.name });
    else if (!target.writable) view.note = `Can't clone into ${at}: no permission.`;
    else view.rows.push({ kind: 'cloneHere', path: target.path, name: target.name, repo: clone!.repo, taken: target.taken });
  };
  const path = normalizeFolderPath(input.typed);
  const { parent, tail } = splitFolderPath(path);
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
      if (clone) cloneLead(parent);
      else if (parent !== '~' && read.start !== false) view.rows.push({ kind: 'start', path: parent, name: folderName(parent) });
      view.rows.push(...names.map(row));
      if (view.rows.length === 0) view.note = `${parent} has no folders.`;
      return view;
    }
    const exact = read.folders.includes(tail) ? tail : null;
    const typedPath = child(parent, tail);
    if (exact) {
      if (locked.has(exact)) view.note = `Can't open ${typedPath}: no permission.`;
      else if (clone) cloneLead(typedPath);
      else if (!(read.nostart ?? []).includes(exact)) view.rows.push({ kind: 'start', path: typedPath, name: tail });
      view.rows.push(...names.map(row));
      return view;
    }
    const named = input.nameRead ? (input.nameRead.state ?? (input.nameRead.exists ? 'folder' : 'missing')) : null;
    if (named === 'folder') {
      if (clone) cloneLead(typedPath);
      else if (input.nameRead!.start !== false) view.rows.push({ kind: 'start', path: typedPath, name: tail });
      view.rows.push(...names.map(row));
      return view;
    }
    if (named === 'locked') {
      view.note = `Can't open ${typedPath}: no permission.`;
      return view;
    }
    if (named === 'file') {
      if (/\.\w+$/.test(tail) && parent !== '~' && read.start !== false && !clone) {
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
    view.note = `${folderName(parent)} is a file.`;
    if (nearest) {
      if (nearest.path !== '~' && !clone) view.rows.push({ kind: 'start', path: nearest.path, name: folderName(nearest.path) });
      view.rows.push(...nearRows(nearest.path, nearest.folders, folderName(parent), 0, 3));
    }
    return view;
  }
  if (read.blocked) return { ...view, note: read.blocked.state === 'file' ? `${read.blocked.path} is a file.` : `Can't open ${read.blocked.path}: no permission.` };
  if (!nearest) return { ...view, note: `There's no ${parent}.` };
  const wrong = nameBelow(parent, nearest.path);
  const bad = folderChild(nearest.path, wrong);
  const best = closestFirst(nearest.folders, wrong)[0];
  if (best && wrong && editDistance(best, wrong) <= FIX_MAX_EDITS) {
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

export function needsNameRead(read: FolderRead | null, tail: string): boolean {
  if (!read || tail === '' || tail.startsWith('.')) return false;
  const state = read.state ?? (read.exists ? 'folder' : 'missing');
  return state === 'folder' && !read.folders.includes(tail);
}

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
