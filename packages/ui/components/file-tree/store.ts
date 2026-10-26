/**
 * FileTreeStore — the small external store a `<FileTree>` renders from.
 *
 * It owns the counted index (`FileTreeModel`), the expanded folders, the
 * host's badges and the filter. Every change bumps one version number and
 * notifies once, so React reads it with `useSyncExternalStore` and expand-all
 * is one update and one render. A host that keeps a live folder watch calls
 * `add` / `remove` (or `setPaths` with a fresh snapshot); everything else is
 * read by the component.
 *
 * While a filter is set the tree shows a second index built from the paths it
 * keeps, fully expanded (FileBrowser's behaviour); the unfiltered tree keeps
 * its own expansion for when the filter is cleared.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { FileTreeModel, normalizeTreePath, ROOT, type FileTreeValues } from './model';
import { filterTreePaths, treeFilterTokens } from './filter';

/** Colour family for a status letter (FileBrowser's git letters). */
export type FileTreeTone = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'ignored';

/** Colour family for a small round marker (FileBrowser's save-state markers). */
export type FileTreeMarkerTone = 'primary' | 'success' | 'warning' | 'destructive';

/**
 * What the host shows on one row. Only letters, numbers and glyphs are drawn:
 * words go in `label` (and `marker.label`), read by screen readers.
 */
export interface FileTreeBadge {
  /** A one-letter status (git's `A`, `U`, `D`, `R`, `M`, `!`). */
  letter?: string;
  tone?: FileTreeTone;
  /** Lines added and deleted: drawn `+N -N`; folders show the sums of their files. */
  additions?: number;
  deletions?: number;
  /** A count (comments on the file), drawn as a small pill; folders show the sum. */
  count?: number;
  /** A small round marker before the count (a save state: `•`, `!`, `✓`). */
  marker?: { glyph: string; tone: FileTreeMarkerTone; label?: string };
  /** Draw the name struck through (a file deleted on disk). */
  struck?: boolean;
  /** The row cannot be opened. */
  disabled?: boolean;
  /** What the badge means, for screen readers ("Added, 2 comments"). */
  label?: string;
  /** Counts toward the dot on a collapsed folder. Default: true when there is a letter. */
  rollup?: boolean;
}

export interface FileTreeStoreOptions {
  /** Folders open at the start (paths). */
  expanded?: Iterable<string>;
  badges?: ReadonlyMap<string, FileTreeBadge> | null;
  /** The name a row shows; the filter matches on it too. Default: the name. */
  displayName?: (name: string) => string;
}

function badgeValues(badges: ReadonlyMap<string, FileTreeBadge> | null): Map<string, FileTreeValues> {
  const out = new Map<string, FileTreeValues>();
  if (!badges) return out;
  for (const [path, b] of badges) {
    out.set(path, { mark: b.rollup ?? !!b.letter, additions: b.additions, deletions: b.deletions, count: b.count });
  }
  return out;
}

export class FileTreeStore {
  /** The whole tree. */
  readonly base: FileTreeModel;
  private filtered: FileTreeModel | null = null;
  private filterQuery = '';
  private version = 0;
  private listeners = new Set<() => void>();
  private badgeMap = new Map<string, FileTreeBadge>();
  private badgeSource: ReadonlyMap<string, FileTreeBadge> | null = null;
  private values = new Map<string, FileTreeValues>();
  readonly displayName: (name: string) => string;

  constructor(paths: Iterable<string> = [], options: FileTreeStoreOptions = {}) {
    this.displayName = options.displayName ?? ((name) => name);
    if (options.badges) this.indexBadges(options.badges);
    this.base = new FileTreeModel(paths, { expanded: options.expanded, values: this.values });
  }

  /** The tree on screen: the filtered one while a filter is set. */
  get model(): FileTreeModel {
    return this.filtered ?? this.base;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Run several changes on the tree on screen as one update (one version bump, one render). */
  batch(change: (model: FileTreeModel) => boolean | void): boolean {
    const changed = change(this.model) !== false;
    if (changed) this.commit();
    return changed;
  }

  private commit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private done(changed: boolean): boolean {
    if (changed) this.commit();
    return changed;
  }

  // ---------------------------------------------------------------- paths

  /** Make the tree hold exactly `paths` (a fresh snapshot): only the difference is applied. */
  setPaths(paths: Iterable<string>): boolean {
    const changed = this.base.setPaths(paths);
    if (changed) this.refilter();
    return this.done(changed);
  }

  /** List paths (a trailing `/` lists an empty folder). */
  add(paths: string | Iterable<string>): boolean {
    let changed = false;
    for (const p of typeof paths === 'string' ? [paths] : paths) changed = this.base.add(p) || changed;
    if (changed) this.refilter();
    return this.done(changed);
  }

  /** Remove paths and everything under them. */
  remove(paths: string | Iterable<string>): boolean {
    let changed = false;
    for (const p of typeof paths === 'string' ? [paths] : paths) changed = this.base.remove(p) || changed;
    if (changed) this.refilter();
    return this.done(changed);
  }

  // ---------------------------------------------------------------- filter

  get filter(): string {
    return this.filterQuery;
  }

  /** Show only what matches `query` (FileBrowser's rules), fully expanded. An empty query shows everything. */
  setFilter(query: string): boolean {
    if (query === this.filterQuery) return false;
    this.filterQuery = query;
    const wasFiltered = this.filtered !== null;
    this.filtered = null;
    this.refilter(true);
    return this.done(wasFiltered || this.filtered !== null);
  }

  private refilter(fresh = false): void {
    if (treeFilterTokens(this.filterQuery).length === 0) {
      this.filtered = null;
      return;
    }
    const kept = filterTreePaths(this.base.listedPaths(), this.filterQuery, this.displayName);
    const previous = fresh ? null : this.filtered;
    const next = new FileTreeModel(kept, { values: this.values, expanded: previous?.expandedPaths() });
    if (!previous) next.expandAll();
    this.filtered = next;
  }

  // ---------------------------------------------------------------- expansion

  isExpanded(path: string): boolean {
    const id = this.model.find(path);
    return id > ROOT && this.model.isExpanded(id);
  }

  expandedPaths(): Set<string> {
    return this.model.expandedPaths();
  }

  expand(path: string): boolean {
    return this.done(this.model.expand(this.model.find(path)));
  }

  collapse(path: string): boolean {
    return this.done(this.model.collapse(this.model.find(path)));
  }

  toggle(path: string): boolean {
    const id = this.model.find(path);
    if (id <= ROOT) return false;
    return this.done(this.model.isExpanded(id) ? this.model.collapse(id) : this.model.expand(id));
  }

  /**
   * Expand everything (no path), or a folder, its ancestors and every folder
   * under it. One pass and one render.
   */
  expandAll(path?: string): boolean {
    if (path === undefined) return this.done(this.model.expandAll());
    const id = this.model.find(path);
    if (id <= ROOT) return false;
    const a = this.model.expandAncestors(id);
    const b = this.model.expandAll(id);
    return this.done(a || b);
  }

  /** Collapse everything (no path), or a folder and every folder under it. */
  collapseAll(path?: string): boolean {
    if (path === undefined) return this.done(this.model.collapseAll());
    const id = this.model.find(path);
    return id > ROOT ? this.done(this.model.collapseAll(id)) : false;
  }

  /** Expand the folders above `path` so its row shows. Returns its row, or -1 when it is not in the tree. */
  reveal(path: string): number {
    const id = this.model.find(path);
    if (id <= ROOT) return -1;
    this.done(this.model.expandAncestors(id));
    return this.model.indexOfId(id);
  }

  // ---------------------------------------------------------------- badges

  /**
   * Replace the badges (keyed by path). Folder roll-ups (sums and the dot on a
   * collapsed folder) are counted in the index here, never in render.
   */
  setBadges(badges: ReadonlyMap<string, FileTreeBadge> | null): boolean {
    if (badges === this.badgeSource) return false;
    this.indexBadges(badges);
    this.base.setValues(this.values);
    this.filtered?.setValues(this.values);
    this.commit();
    return true;
  }

  private indexBadges(badges: ReadonlyMap<string, FileTreeBadge> | null): void {
    this.badgeSource = badges;
    this.badgeMap = new Map();
    if (badges) {
      for (const [path, badge] of badges) {
        const key = normalizeTreePath(path)?.key;
        if (key) this.badgeMap.set(key, badge);
      }
    }
    this.values = badgeValues(badges);
  }

  badgeOf(path: string): FileTreeBadge | undefined {
    return this.badgeMap.get(path);
  }
}

export function createFileTreeStore(paths: Iterable<string> = [], options?: FileTreeStoreOptions): FileTreeStore {
  return new FileTreeStore(paths, options);
}

/**
 * One store for the life of the component, kept in step with `paths`,
 * `badges` and `filter` (a new array or map identity is applied as a diff
 * before paint). `displayName` and `initialExpanded` are read once.
 */
export function useFileTree(
  paths: readonly string[],
  options: {
    badges?: ReadonlyMap<string, FileTreeBadge> | null;
    filter?: string;
    initialExpanded?: Iterable<string>;
    displayName?: (name: string) => string;
  } = {},
): FileTreeStore {
  const [store] = useState(() => {
    const s = new FileTreeStore(paths, { expanded: options.initialExpanded, badges: options.badges, displayName: options.displayName });
    if (options.filter) s.setFilter(options.filter);
    return s;
  });
  const seenPaths = useRef(paths);
  useLayoutEffect(() => {
    if (seenPaths.current === paths) return;
    seenPaths.current = paths;
    store.setPaths(paths);
  }, [store, paths]);
  const badges = options.badges ?? null;
  useLayoutEffect(() => {
    store.setBadges(badges);
  }, [store, badges]);
  const filter = options.filter ?? '';
  useLayoutEffect(() => {
    store.setFilter(filter);
  }, [store, filter]);
  return store;
}
