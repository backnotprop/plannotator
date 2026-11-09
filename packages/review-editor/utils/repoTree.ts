/**
 * The model behind the tree's "All files" (approved design record
 * "review-explorer", step 1): the whole repository at the diff's new side as
 * folders, with the review's changed files merged in.
 *
 * Built for big repositories: the folder index is built once per listing
 * (linear in paths), and only the rows of expanded folders are ever walked, so
 * the virtualized list renders a window of a flat row array.
 */

export interface RepoFolder {
  /** "" for the root. */
  path: string;
  dirs: string[];
  files: string[];
  /** Lazy listings: the server has not sent this folder's children yet. */
  loaded: boolean;
}

export interface RepoTreeIndex {
  folders: Map<string, RepoFolder>;
  /** Every file path known (listed or changed). */
  fileCount: number;
}

export type RepoTreeRow =
  | { kind: 'folder'; path: string; name: string; depth: number; expanded: boolean; loaded: boolean }
  | { kind: 'file'; path: string; name: string; depth: number }
  | { kind: 'loading'; path: string; depth: number };

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function ensureFolder(folders: Map<string, RepoFolder>, path: string, loaded: boolean): RepoFolder {
  let folder = folders.get(path);
  if (!folder) {
    folder = { path, dirs: [], files: [], loaded };
    folders.set(path, folder);
    if (path !== '') {
      const parent = ensureFolder(folders, parentOf(path), loaded);
      parent.dirs.push(path);
    }
  }
  return folder;
}

function sortFolders(folders: Map<string, RepoFolder>): void {
  for (const folder of folders.values()) {
    folder.dirs.sort((a, b) => compareNames(baseName(a), baseName(b)));
    folder.files.sort((a, b) => compareNames(baseName(a), baseName(b)));
  }
}

/**
 * Index a whole listing. `extra` are paths the review holds that the listing
 * does not (a file the diff deletes), so a changed file never drops out of
 * the tree.
 */
export function buildRepoTreeIndex(paths: readonly string[], extra: readonly string[] = []): RepoTreeIndex {
  const folders = new Map<string, RepoFolder>();
  ensureFolder(folders, '', true);
  const seen = new Set<string>();
  for (const path of [...paths, ...extra]) {
    if (seen.has(path)) continue;
    seen.add(path);
    ensureFolder(folders, parentOf(path), true).files.push(path);
  }
  sortFolders(folders);
  return { folders, fileCount: seen.size };
}

/** One folder's children as the server sent them (lazy listings). */
export interface RepoDirEntryLike {
  path: string;
  type: 'file' | 'dir';
}

/**
 * Add one folder's children to a lazy index (returns a new index). Folders the
 * entries name start unloaded; the folder itself becomes loaded.
 */
export function addRepoDirEntries(
  index: RepoTreeIndex,
  dir: string,
  entries: readonly RepoDirEntryLike[],
  extra: readonly string[] = [],
): RepoTreeIndex {
  const folders = new Map(index.folders);
  const clone = (path: string): RepoFolder => {
    const existing = folders.get(path);
    const copy: RepoFolder = existing
      ? { ...existing, dirs: [...existing.dirs], files: [...existing.files] }
      : { path, dirs: [], files: [], loaded: false };
    folders.set(path, copy);
    if (!existing && path !== '') {
      const parent = clone(parentOf(path));
      if (!parent.dirs.includes(path)) parent.dirs.push(path);
    }
    return copy;
  };
  const target = clone(dir);
  target.loaded = true;
  target.dirs = [];
  target.files = [];
  let added = 0;
  for (const entry of entries) {
    if (entry.type === 'dir') {
      target.dirs.push(entry.path);
      if (!folders.has(entry.path)) folders.set(entry.path, { path: entry.path, dirs: [], files: [], loaded: false });
    } else {
      target.files.push(entry.path);
      added += 1;
    }
  }
  // Changed files under this folder that the listing does not hold.
  for (const path of extra) {
    if (parentOf(path) === dir && !target.files.includes(path)) target.files.push(path);
  }
  target.dirs.sort((a, b) => compareNames(baseName(a), baseName(b)));
  target.files.sort((a, b) => compareNames(baseName(a), baseName(b)));
  return { folders, fileCount: index.fileCount + added };
}

/** An empty lazy index whose root is not loaded yet. */
export function emptyLazyRepoTreeIndex(): RepoTreeIndex {
  const folders = new Map<string, RepoFolder>();
  folders.set('', { path: '', dirs: [], files: [], loaded: false });
  return { folders, fileCount: 0 };
}

/** Every folder above a path ("" excluded), outermost first. */
export function repoAncestors(path: string): string[] {
  const out: string[] = [];
  let dir = parentOf(path);
  while (dir !== '') {
    out.unshift(dir);
    dir = parentOf(dir);
  }
  return out;
}

/** The rows on screen: folders and files under expanded folders, depth first. */
export function flattenRepoTree(
  index: RepoTreeIndex,
  expanded: ReadonlySet<string>,
): RepoTreeRow[] {
  const rows: RepoTreeRow[] = [];
  const walk = (folderPath: string, depth: number) => {
    const folder = index.folders.get(folderPath);
    if (!folder) return;
    if (!folder.loaded) {
      rows.push({ kind: 'loading', path: folderPath, depth });
      return;
    }
    for (const dir of folder.dirs) {
      const isExpanded = expanded.has(dir);
      const child = index.folders.get(dir);
      rows.push({
        kind: 'folder',
        path: dir,
        name: baseName(dir),
        depth,
        expanded: isExpanded,
        loaded: child?.loaded ?? false,
      });
      if (isExpanded) walk(dir, depth + 1);
    }
    for (const file of folder.files) rows.push({ kind: 'file', path: file, name: baseName(file), depth });
  };
  walk('', 0);
  return rows;
}

/** Folders to open first: the ancestors of every changed file (and of the active one). */
export function initialRepoExpansion(changedPaths: Iterable<string>, activePath?: string | null): Set<string> {
  const open = new Set<string>();
  for (const path of changedPaths) for (const dir of repoAncestors(path)) open.add(dir);
  if (activePath) for (const dir of repoAncestors(activePath)) open.add(dir);
  return open;
}
