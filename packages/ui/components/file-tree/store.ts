/**
 * FileTreeStore — the small external store a `<FileTree>` renders from.
 *
 * It owns the counted index (`FileTreeModel`), the expanded folders, the
 * host's badges and the filter. Every change bumps one version number and
 * notifies once, so React reads it with `useSyncExternalStore` and expand-all
 * is one update and one render. A host that keeps a live folder watch calls
 * `add` / `remove` (or `setPaths` with a fresh snapshot).
 *
 * Built in slices (`sliced: true`, what `useFileTree` asks for): a large list
 * first shows a small index of its top-level entries, which is exactly what
 * the tree shows with nothing open, then builds the full index a few
 * milliseconds at a time between tasks and swaps it in. Changes made in the
 * meantime are applied to both. The swap gives every node a new id, which is
 * why everything outside the model (focus, reveal, scroll anchor) is kept by
 * path.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileTreeModel, normalizeTreePath, ROOT, type FileTreeValues } from './model';
import { treeFilterTest } from './filter';

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
  /** The name a row shows. Default: the name. */
  displayName?: (name: string) => string;
  /** Build a large list in slices, showing its top-level entries first. Default false (build now). */
  sliced?: boolean;
}

/** Below this many paths a build is a few milliseconds and runs at once. */
const SLICE_MIN_PATHS = 4000;
/** Time per build slice. */
const SLICE_MS = 8;

function badgeValues(badges: ReadonlyMap<string, FileTreeBadge> | null): Map<string, FileTreeValues> {
  const out = new Map<string, FileTreeValues>();
  if (!badges) return out;
  for (const [path, b] of badges) {
    out.set(path, { mark: b.rollup ?? !!b.letter, additions: b.additions, deletions: b.deletions, count: b.count });
  }
  return out;
}

/** The top-level entries of a path list: what the tree shows with nothing open. */
function topLevel(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const p of paths) {
    // A plain path (most of a folder walk) needs only its first slash.
    if (p.length > 0 && p.charCodeAt(0) !== 47 && p.charCodeAt(0) !== 46 && !p.includes('//') && !p.endsWith('/')) {
      const slash = p.indexOf('/');
      seen.add(slash < 0 ? p : `${p.slice(0, slash)}/`);
      continue;
    }
    const norm = normalizeTreePath(p);
    if (!norm) continue;
    const top = norm.segments[0];
    seen.add(norm.segments.length > 1 || norm.dir ? `${top}/` : top);
  }
  return [...seen];
}

/** Run `fn` after the browser has had a turn (a message, not a 4 ms-clamped timer). */
function nextTurn(fn: () => void): () => void {
  if (typeof MessageChannel !== 'undefined') {
    const ch = new MessageChannel();
    let cancelled = false;
    ch.port1.onmessage = () => {
      ch.port1.close();
      if (!cancelled) fn();
    };
    ch.port2.postMessage(null);
    return () => {
      cancelled = true;
      ch.port1.close();
    };
  }
  const t = setTimeout(fn, 0);
  return () => clearTimeout(t);
}

type Op = (model: FileTreeModel) => unknown;

export class FileTreeStore {
  private current: FileTreeModel;
  /** A sliced build: the model being built, its steps, the filter when it started, and every change made since, in order. */
  private building: { model: FileTreeModel; steps: Generator<void, void, void>; test: ((lc: string) => boolean) | null; ops: Op[] } | null = null;
  private cancelTurn: (() => void) | null = null;
  private readyWaiters: Array<() => void> = [];
  private filterQuery = '';
  private test: ((lc: string) => boolean) | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  private badgeMap = new Map<string, FileTreeBadge>();
  private badgeSource: ReadonlyMap<string, FileTreeBadge> | null = null;
  private values = new Map<string, FileTreeValues>();
  private initialExpanded: string[] | undefined;
  readonly displayName: (name: string) => string;

  constructor(paths: Iterable<string> = [], options: FileTreeStoreOptions = {}) {
    this.displayName = options.displayName ?? ((name) => name);
    this.initialExpanded = options.expanded ? [...options.expanded] : undefined;
    if (options.badges) this.indexBadges(options.badges);
    const list = Array.isArray(paths) ? (paths as string[]) : [...paths];
    if (options.sliced && list.length >= SLICE_MIN_PATHS) {
      this.current = new FileTreeModel(topLevel(list), { values: this.values });
      this.startBuild(list);
    } else {
      this.current = new FileTreeModel(list, { expanded: this.initialExpanded, values: this.values });
    }
  }

  /** The tree on screen. Its node ids change when a sliced build lands or a snapshot rebuilds: keep paths, not ids. */
  get model(): FileTreeModel {
    return this.current;
  }

  /** The full index is still being built (the tree shows the top-level entries). */
  get loading(): boolean {
    return this.building !== null;
  }

  /** Resolves once the full index is on screen. */
  whenReady(): Promise<void> {
    if (!this.building) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Pause a build in progress (the component using the store unmounted). `resume` picks it up again. */
  dispose(): void {
    this.cancelTurn?.();
    this.cancelTurn = null;
  }

  /** Continue a build that `dispose` paused (React mounts effects twice in development). */
  resume(): void {
    if (this.building && !this.cancelTurn) this.cancelTurn = nextTurn(() => this.pump());
  }

  private commit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** Apply `op` to the tree on screen and, while a build runs, to the index being built. */
  private run(op: Op): boolean {
    this.building?.ops.push(op);
    const changed = op(this.current) !== false;
    if (changed) this.commit();
    return changed;
  }

  /** Run several changes on the tree as one update (one version bump, one render). */
  batch(change: (model: FileTreeModel) => boolean | void): boolean {
    return this.run(change);
  }

  // ---------------------------------------------------------------- build

  private startBuild(paths: string[]): void {
    this.cancelTurn?.();
    const model = new FileTreeModel(paths, { expanded: this.initialExpanded, values: this.values, deferBuild: true });
    this.building = { model, steps: model.build(), test: this.test, ops: [] };
    this.cancelTurn = nextTurn(() => this.pump());
  }

  private pump(): void {
    const job = this.building;
    if (!job) return;
    const until = performance.now() + SLICE_MS;
    while (performance.now() < until) {
      if (job.steps.next().done) {
        this.finishBuild(job);
        return;
      }
    }
    this.cancelTurn = nextTurn(() => this.pump());
  }

  private finishBuild(job: NonNullable<FileTreeStore['building']>): void {
    const { model, ops } = job;
    // The new index, then every change the preview took meanwhile, in the same order.
    if (job.test) model.setFilter(job.test);
    for (const op of ops) op(model);
    this.current = model;
    this.building = null;
    this.cancelTurn = null;
    this.commit();
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w();
  }

  // ---------------------------------------------------------------- paths

  /** Make the tree hold exactly `paths` (a fresh snapshot): only the difference is applied. */
  setPaths(paths: Iterable<string>): boolean {
    const list = Array.isArray(paths) ? (paths as string[]) : [...paths];
    if (this.building) {
      // The build in progress is out of date: start again from this list.
      this.current.setPaths(topLevel(list));
      this.startBuild(list);
      this.commit();
      return true;
    }
    return this.run((m) => m.setPaths(list));
  }

  /** List paths (a trailing `/` lists an empty folder). Under a filter, a new match shows with its folders open. */
  add(paths: string | Iterable<string>): boolean {
    const list = typeof paths === 'string' ? [paths] : [...paths];
    return this.run((m) => {
      let changed = false;
      for (const p of list) changed = m.add(p) || changed;
      return changed;
    });
  }

  /** Remove paths and everything under them. */
  remove(paths: string | Iterable<string>): boolean {
    const list = typeof paths === 'string' ? [paths] : [...paths];
    return this.run((m) => {
      let changed = false;
      for (const p of list) changed = m.remove(p) || changed;
      return changed;
    });
  }

  // ---------------------------------------------------------------- filter

  get filter(): string {
    return this.filterQuery;
  }

  /**
   * Show only the paths that match `query` (FileBrowser's rules) and their
   * folders, all open. An empty query shows everything with the unfiltered
   * expansion back. One pass over the index (a few ms for 150k paths).
   */
  setFilter(query: string): boolean {
    if (query === this.filterQuery) return false;
    const test = treeFilterTest(query);
    this.filterQuery = query;
    if (test === null && this.test === null) return false;
    this.test = test;
    this.building?.ops.push((m) => m.setFilter(test));
    this.current.setFilter(test);
    this.commit();
    return true;
  }

  // ---------------------------------------------------------------- expansion

  isExpanded(path: string): boolean {
    const id = this.current.find(path);
    return id > ROOT && this.current.isExpanded(id);
  }

  expandedPaths(): Set<string> {
    return this.current.expandedPaths();
  }

  expand(path: string): boolean {
    return this.run((m) => m.expand(m.find(path)));
  }

  collapse(path: string): boolean {
    return this.run((m) => m.collapse(m.find(path)));
  }

  toggle(path: string): boolean {
    return this.run((m) => {
      const id = m.find(path);
      if (id <= ROOT) return false;
      return m.isExpanded(id) ? m.collapse(id) : m.expand(id);
    });
  }

  /**
   * Expand everything (no path), or a folder, its ancestors and every folder
   * under it. One pass and one render.
   */
  expandAll(path?: string): boolean {
    return this.run((m) => {
      if (path === undefined) return m.expandAll();
      const id = m.find(path);
      if (id <= ROOT) return false;
      const a = m.expandAncestors(id);
      const b = m.expandAll(id);
      return a || b;
    });
  }

  /** Collapse everything (no path), or a folder and every folder under it. */
  collapseAll(path?: string): boolean {
    return this.run((m) => {
      if (path === undefined) return m.collapseAll();
      const id = m.find(path);
      return id > ROOT ? m.collapseAll(id) : false;
    });
  }

  /** Expand the folders above `path` so its row shows. Returns its row, or -1 when it is not in the tree. */
  reveal(path: string): number {
    this.run((m) => {
      const id = m.find(path);
      return id > ROOT ? m.expandAncestors(id) : false;
    });
    return this.current.indexOf(path);
  }

  // ---------------------------------------------------------------- badges

  /**
   * Replace the badges (keyed by path). Folder roll-ups (sums and the dot on a
   * collapsed folder) are counted in the index here, never in render.
   */
  setBadges(badges: ReadonlyMap<string, FileTreeBadge> | null): boolean {
    if (badges === this.badgeSource) return false;
    this.indexBadges(badges);
    const values = this.values;
    this.building?.ops.push((m) => m.setValues(values));
    this.current.setValues(values);
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
 * One store for the life of the component, built in slices, kept in step with
 * `paths`, `badges` and `filter` (a new array or map identity, or a new query,
 * is applied before paint). `displayName` and `initialExpanded` are read once.
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
    const s = new FileTreeStore(paths, { expanded: options.initialExpanded, badges: options.badges, displayName: options.displayName, sliced: true });
    if (options.filter) s.setFilter(options.filter);
    return s;
  });
  useEffect(() => {
    store.resume();
    return () => store.dispose();
  }, [store]);
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
