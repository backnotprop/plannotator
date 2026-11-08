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

/**
 * The folder the field names, when the names read show it is there: the parent itself when nothing is typed after its
 * slash (never the home folder: an agent is not started in all of home), or a name read that the tail spells exactly.
 * Null: not a folder the person can start in (yet).
 */
export function namedFolder(read: { parent: string; exists: boolean; folders: readonly string[] }, tail: string): string | null {
  if (!read.exists) return null;
  if (tail === '') return read.parent === '~' ? null : read.parent;
  return read.folders.includes(tail) ? folderChild(read.parent, tail) : null;
}

/** The path the person typed, as the missing line names it: no slash at the end. */
export function shownFolderPath(typed: string): string {
  const path = normalizeFolderPath(typed);
  return path.length > 2 ? path.replace(/\/+$/, '') : path;
}

/**
 * The line in place of the names when the typed path isn't there. `below`: folders are listed under it (what is there
 * instead); without any, it doesn't point at them.
 */
export function missingFolderLine(machine: string | null, path: string, below = true): string {
  const pick = below ? ', or pick a folder below' : '';
  return machine ? `${machine} has no folder ${path}. Check the path${pick}.` : `There's no folder ${path}. Check the path${pick}.`;
}

/** How many single-letter edits turn one name into another (case aside): how close a folder is to what was typed. */
function editDistance(a: string, b: string): number {
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
