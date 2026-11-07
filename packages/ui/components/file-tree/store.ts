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
 * first shows a small index of the rows the tree shows at the start (its
 * top-level entries, and what is inside the folders given as open), then
 * builds the full index a few milliseconds at a time between tasks and swaps
 * it in. The build starts once someone uses the store (`subscribe`,
 * `whenReady` or `resume`). Changes made in the meantime are applied to the
 * preview and queued; once the index is built they are replayed on it in
 * order, one per step, so it ends as a store built at once would. A filter
 * set meanwhile waits for the full index (`filterPending`). A snapshot
 * (`setPaths`) during the build is queued the same way. A large snapshot
 * (changing over a quarter of the paths) is built in slices too. The swap
 * gives every node a new id, which is why everything outside the model
 * (focus, reveal, scroll anchor) is kept by path.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileTreeModel, isPlainPath, normalizeTreePath, ROOT, type FileTreeValues } from './model';
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
  /** A count (comments on the file), drawn as a small pill on the file's row; folders show none. */
  count?: number;
  /** A small round marker before the count (a save state: `•`, `!`, `✓`). */
  marker?: { glyph: string; tone: FileTreeMarkerTone; label?: string };
  /** Draw the name struck through (a file deleted on disk). */
  struck?: boolean;
  /** The row cannot be opened (Enter, Space and a click do nothing; it still takes focus). */
  disabled?: boolean;
  /**
   * Listed but never opened (a secrets file, a link out of the folder): the
   * row is disabled, draws a lock in place of its icon, and this text is its
   * tooltip and its screen-reader description. The host owns the words.
   */
  locked?: string;
  /** Drawn quieter (a git-ignored file or folder): still opens. */
  dimmed?: boolean;
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
  /**
   * Lazy folders: a folder listed with a trailing `/` and nothing under it
   * yet is loaded the first time it opens (by a click, a key, `expand`,
   * `expandAll(path)` or `*`). The loader gets the folder's path and resolves
   * with the paths to add (full paths; a folder ends in `/`), or adds them
   * itself and resolves with nothing. A folder is loaded once; a failed load
   * closes the folder again and the next open tries again.
   */
  loadChildren?: FileTreeLoader | null;
  /** How long a load runs before its row shows a spinner. Default 300 ms (a quick load shows none). */
  loadingDelayMs?: number;
}

/** Loads one folder's children (see `FileTreeStoreOptions.loadChildren`). */
export type FileTreeLoader = (dir: string) => Promise<Iterable<string> | void>;

/** Below this many paths a build is a few milliseconds and runs at once. */
const SLICE_MIN_PATHS = 4000;
/** Time per build slice. */
const SLICE_MS = 8;

function badgeValues(badges: ReadonlyMap<string, FileTreeBadge> | null): Map<string, FileTreeValues> {
  const out = new Map<string, FileTreeValues>();
  if (!badges) return out;
  for (const [path, b] of badges) {
    out.set(path, { mark: b.rollup ?? !!b.letter, additions: b.additions, deletions: b.deletions });
  }
  return out;
}

/** A preview with more rows than this is built as part of the full index instead (see `visibleEntries`). */
const PREVIEW_MAX = 20_000;

/**
 * The entries a path list shows with only `expanded` open: each path cut at
 * its first folder that is not open (a folder entry ends in `/`). With
 * nothing open these are the top-level entries. Null when there are more
 * than `max` (the preview would cost as much as the index).
 */
function visibleEntries(paths: readonly string[], expanded: ReadonlySet<string>, max: number): string[] | null {
  const seen = new Set<string>();
  const open = expanded.size > 0;
  for (const p of paths) {
    if (isPlainPath(p)) {
      let start = 0;
      for (;;) {
        const slash = p.indexOf('/', start);
        if (slash < 0) {
          seen.add(p);
          break;
        }
        if (!open || !expanded.has(p.slice(0, slash))) {
          seen.add(p.slice(0, slash + 1));
          break;
        }
        start = slash + 1;
      }
    } else {
      const norm = normalizeTreePath(p);
      if (!norm) continue;
      const segs = norm.segments;
      let key = '';
      for (let i = 0; i < segs.length; i++) {
        key = i === 0 ? segs[0] : `${key}/${segs[i]}`;
        const last = i === segs.length - 1;
        if (last) {
          seen.add(norm.dir ? `${key}/` : key);
          break;
        }
        if (!open || !expanded.has(key)) {
          seen.add(`${key}/`);
          break;
        }
      }
    }
    if (seen.size > max) return null;
  }
  return [...seen];
}

/** Folder keys for a list of paths given as open. */
function expandedKeys(paths: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!paths) return out;
  for (const p of paths) {
    const key = normalizeTreePath(p)?.key;
    if (key) out.add(key);
  }
  return out;
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

type FilterTest = (lowercasePath: string) => boolean;
type Change = (model: FileTreeModel) => boolean | void;

/**
 * A change, kept while the index builds and replayed on it in order.
 * `expansion` changes only touch which folders are open (the replay skips
 * them when a later filter makes them moot); `snapshot` is a `setPaths` made
 * during the build.
 */
type Op =
  | { kind: 'expansion' | 'paths' | 'other'; run: Change }
  | { kind: 'values'; values: Map<string, FileTreeValues> }
  | { kind: 'filter'; test: FilterTest | null }
  | { kind: 'snapshot'; paths: string[] };

function applyOp(model: FileTreeModel, op: Op): boolean {
  switch (op.kind) {
    case 'filter':
      if (op.test === null && !model.filtered) return false;
      model.setFilter(op.test);
      return true;
    case 'values':
      model.setValues(op.values);
      return true;
    case 'snapshot':
      return model.setPaths(op.paths);
    default:
      return op.run(model) !== false;
  }
}

/**
 * Where the replay goes next from `ops[i]`: `i`, or a later op that makes
 * `ops[i]` moot. A filter followed by another with only expansion changes
 * between is moot (those touch the filter's own open folders, which the next
 * filter recomputes), so ten keystrokes typed while the index builds cost one
 * filter pass. (A snapshot is never moot: one that removes a folder forgets
 * that it was open, even when the next brings it back.)
 */
function skipMoot(ops: readonly Op[], i: number): number {
  for (;;) {
    const op = ops[i];
    if (op.kind !== 'filter') return i;
    let j = i + 1;
    while (j < ops.length && ops[j].kind === 'expansion') j++;
    const later = ops[j];
    if (!later || later.kind !== 'filter' || (op.test === null && j !== i + 1)) return i;
    i = j;
  }
}

interface BuildJob {
  model: FileTreeModel;
  steps: Generator<void, void, void>;
  /**
   * Building the index, filling the filter's lowercase paths when a filter
   * waits, then replaying `ops` (`apply` while a snapshot's difference is
   * applied in steps).
   */
  phase: 'build' | 'filter' | 'replay' | 'apply';
  /** Every change since the build started, in order. */
  ops: Op[];
  /** The next op to replay. */
  next: number;
}

export class FileTreeStore {
  private current: FileTreeModel;
  private building: BuildJob | null = null;
  private cancelTurn: (() => void) | null = null;
  /** The build runs only once someone uses the store (a subscriber, `whenReady` or `resume`), so a store made and dropped (React's StrictMode) costs no build. */
  private active = false;
  private paused = false;
  private finalized = false;
  private readyWaiters: Array<() => void> = [];
  private filterQuery = '';
  private test: FilterTest | null = null;
  private version = 0;
  private listeners = new Set<() => void>();
  private badgeMap = new Map<string, FileTreeBadge>();
  private badgeSource: ReadonlyMap<string, FileTreeBadge> | null = null;
  private values = new Map<string, FileTreeValues>();
  private sliced: boolean;
  private initialExpanded: string[] | undefined;
  private loader: FileTreeLoader | null;
  private loadingDelayMs: number;
  /** Folders whose children were loaded (by key). */
  private loadedDirs = new Set<string>();
  /** Loads in flight by folder key: `slow` once the spinner delay passed. */
  private loads = new Map<string, { slow: boolean; timer: ReturnType<typeof setTimeout> | null }>();
  readonly displayName: (name: string) => string;

  constructor(paths: Iterable<string> = [], options: FileTreeStoreOptions = {}) {
    this.displayName = options.displayName ?? ((name) => name);
    this.loader = options.loadChildren ?? null;
    this.loadingDelayMs = options.loadingDelayMs ?? 300;
    this.initialExpanded = options.expanded ? [...options.expanded] : undefined;
    this.sliced = options.sliced ?? false;
    if (options.badges) this.indexBadges(options.badges);
    const list = Array.isArray(paths) ? (paths as string[]) : [...paths];
    const preview = this.sliced && list.length >= SLICE_MIN_PATHS ? visibleEntries(list, expandedKeys(this.initialExpanded), PREVIEW_MAX) : null;
    if (preview) {
      // The preview is exactly the rows the full tree shows at the start.
      this.current = new FileTreeModel(preview, { expanded: this.initialExpanded, values: this.values });
      this.startBuild(list, this.initialExpanded, null, []);
    } else {
      this.current = new FileTreeModel(list, { expanded: this.initialExpanded, values: this.values });
    }
  }

  /** The tree on screen. Its node ids change when a sliced build lands or a snapshot rebuilds: keep paths, not ids. */
  get model(): FileTreeModel {
    return this.current;
  }

  /** The full index is still being built (the tree shows its starting rows). */
  get loading(): boolean {
    return this.building !== null;
  }

  /** A filter is set and the index it needs is still being built: there are no filtered rows to show yet. */
  get filterPending(): boolean {
    return this.building !== null && this.test !== null;
  }

  /** Resolves once the full index is on screen (or the store was disposed for good). */
  whenReady(): Promise<void> {
    if (!this.building || this.finalized) return Promise.resolve();
    this.activate();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.activate();
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /**
   * Pause a build in progress (the component using the store unmounted).
   * `resume` picks it up again; when nothing resumes it within a turn (a real
   * unmount, not React's StrictMode remount), anyone waiting on `whenReady`
   * is let go.
   */
  dispose(): void {
    this.paused = true;
    this.cancelTurn?.();
    this.cancelTurn = null;
    setTimeout(() => {
      if (!this.paused) return;
      this.finalized = true;
      this.releaseWaiters();
    }, 0);
  }

  /** Continue a build that `dispose` paused (React mounts effects twice in development). */
  resume(): void {
    this.paused = false;
    this.finalized = false;
    this.activate();
  }

  private activate(): void {
    this.active = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.building && this.active && !this.paused && !this.cancelTurn) this.cancelTurn = nextTurn(() => this.pump());
  }

  private releaseWaiters(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w();
  }

  private commit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /**
   * Apply a change to the tree on screen and, while a build runs, keep it for
   * the index being built. While a filter waits for the index, the preview
   * (never filtered) is left alone: the change only makes sense on the
   * filtered tree.
   */
  private run(op: Op): boolean {
    const job = this.building;
    if (job) {
      job.ops.push(op);
      if (this.test !== null) return true;
    }
    const changed = applyOp(this.current, op);
    if (changed) this.commit();
    return changed;
  }

  /** Run several changes on the tree as one update (one version bump, one render). */
  batch(change: (model: FileTreeModel) => boolean | void): boolean {
    return this.run({ kind: 'other', run: change });
  }

  // ---------------------------------------------------------------- build

  /** Build `paths` in slices with `expanded` open, then replay the filter `test` and `ops` on it. */
  private startBuild(paths: string[], expanded: string[] | undefined, test: FilterTest | null, ops: Op[]): void {
    this.cancelTurn?.();
    this.cancelTurn = null;
    const model = new FileTreeModel(paths, { expanded, values: this.values, deferBuild: true });
    const queued: Op[] = test ? [{ kind: 'filter', test }, ...ops] : ops;
    this.building = { model, steps: model.build(), phase: 'build', ops: queued, next: 0 };
    this.schedule();
  }

  private pump(): void {
    this.cancelTurn = null;
    const job = this.building;
    if (!job) return;
    const start = performance.now();
    const until = start + SLICE_MS;
    while (performance.now() < until) {
      if (job.phase !== 'replay') {
        if (!job.steps.next().done) continue;
        if (job.phase === 'apply') {
          job.phase = 'replay';
        } else if (job.phase === 'build' && job.ops.some((op) => op.kind === 'filter' && op.test !== null)) {
          // Fill the filter's lowercase paths in slices too, so a filter pass is cheap.
          job.phase = 'filter';
          job.steps = job.model.prepareFilter();
        } else {
          job.phase = 'replay';
        }
        continue;
      }
      if (job.next >= job.ops.length) {
        this.finishBuild(job);
        return;
      }
      // A snapshot's diff is one long step (~20 ms for 150k paths): give it a task of its own.
      if (job.ops[job.next].kind === 'snapshot' && performance.now() - start > 1) break;
      if (!this.replayStep(job)) return;
    }
    this.schedule();
  }

  /**
   * Replay one queued change on the index being built: one per step, so no
   * task runs long and the swap itself is cheap. False when a large snapshot
   * started a new build.
   */
  private replayStep(job: BuildJob): boolean {
    const i = skipMoot(job.ops, job.next);
    const op = job.ops[i];
    job.next = i + 1;
    if (op.kind !== 'snapshot') {
      applyOp(job.model, op);
      return true;
    }
    const { model } = job;
    const diff = model.diff(op.paths);
    if (diff.adds.length === 0 && diff.removes.length === 0) return true;
    if (!FileTreeModel.rebuildFor(diff)) {
      job.phase = 'apply';
      job.steps = model.applyDiffSteps(diff);
      return true;
    }
    // What a synchronous store does (a rebuild that keeps open folders and the filter), in slices.
    this.startBuild(op.paths, [...model.baseExpandedPaths()], model.filterTest, job.ops.slice(job.next));
    return false;
  }

  private finishBuild(job: BuildJob): void {
    this.current = job.model;
    this.building = null;
    this.cancelTurn = null;
    this.commit();
    this.releaseWaiters();
  }

  // ---------------------------------------------------------------- paths

  /**
   * Make the tree hold exactly `paths` (a fresh snapshot): only the
   * difference is applied. A sliced store builds a large difference (over a
   * quarter of the paths) in slices like the first build, its open folders
   * and filter kept. During a build the snapshot is queued like any change,
   * so the changes before it land first (the tree shows its starting rows
   * meanwhile).
   */
  setPaths(paths: Iterable<string>): boolean {
    const list = Array.isArray(paths) ? (paths as string[]) : [...paths];
    const job = this.building;
    if (job) {
      job.ops.push({ kind: 'snapshot', paths: list });
      this.refreshPreview(list);
      this.commit();
      return true;
    }
    if (!this.sliced || list.length < SLICE_MIN_PATHS) return this.run({ kind: 'paths', run: (m) => m.setPaths(list) });
    const diff = this.current.diff(list);
    if (diff.adds.length === 0 && diff.removes.length === 0) return false;
    if (!FileTreeModel.rebuildFor(diff)) return this.run({ kind: 'paths', run: (m) => m.applyDiff(diff) });
    const expanded = [...this.current.baseExpandedPaths()];
    this.refreshPreview(list, expanded);
    this.startBuild(list, expanded, this.test, []);
    this.commit();
    return true;
  }

  /**
   * Show the new snapshot's starting rows while its index builds. When those
   * would be too many to build quickly, the tree on screen stays as the
   * preview until the index lands.
   */
  private refreshPreview(list: string[], expanded: string[] = [...this.current.baseExpandedPaths()]): void {
    const entries = visibleEntries(list, expandedKeys(expanded), PREVIEW_MAX);
    if (entries) this.current = new FileTreeModel(entries, { expanded, values: this.values });
  }

  /** List paths (a trailing `/` lists an empty folder). Under a filter, a new match shows with its folders open. */
  add(paths: string | Iterable<string>): boolean {
    const list = typeof paths === 'string' ? [paths] : [...paths];
    return this.run({
      kind: 'paths',
      run: (m) => {
        let changed = false;
        for (const p of list) changed = m.add(p) || changed;
        return changed;
      },
    });
  }

  /** Remove paths and everything under them. */
  remove(paths: string | Iterable<string>): boolean {
    const list = typeof paths === 'string' ? [paths] : [...paths];
    return this.run({
      kind: 'paths',
      run: (m) => {
        let changed = false;
        for (const p of list) changed = m.remove(p) || changed;
        return changed;
      },
    });
  }

  // ---------------------------------------------------------------- filter

  get filter(): string {
    return this.filterQuery;
  }

  /**
   * Show only the paths that match `query` (FileBrowser's rules) and their
   * folders, all open. An empty query shows everything with the unfiltered
   * expansion back. One pass over the index (a few ms for 150k paths). While
   * the index builds, the filter is applied when it lands (`filterPending`).
   */
  setFilter(query: string): boolean {
    if (query === this.filterQuery) return false;
    const test = treeFilterTest(query);
    this.filterQuery = query;
    if (test === null && this.test === null) return false;
    this.test = test;
    if (this.building) {
      this.building.ops.push({ kind: 'filter', test });
    } else {
      this.current.setFilter(test);
    }
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
    const changed = this.run({ kind: 'expansion', run: (m) => m.expand(m.find(path)) });
    this.loadOpened();
    return changed;
  }

  // ---------------------------------------------------------------- lazy folders

  /** Set or clear the loader (see `FileTreeStoreOptions.loadChildren`). */
  setLoader(loader: FileTreeLoader | null): void {
    this.loader = loader;
    this.loadOpened();
  }

  /** The folder's children were loaded (or it was never lazy: it had children already). */
  isLoaded(path: string): boolean {
    const key = normalizeTreePath(path)?.key;
    return key !== undefined && this.loadedDirs.has(key);
  }

  /** A load of this folder is running; `slow` once it has run longer than the spinner delay. */
  loadState(path: string): 'slow' | 'pending' | null {
    const key = this.loads.size === 0 ? undefined : normalizeTreePath(path)?.key;
    const load = key === undefined ? undefined : this.loads.get(key);
    return load ? (load.slow ? 'slow' : 'pending') : null;
  }

  /** Mark folders as loaded without asking the loader (the host listed their children itself). */
  markLoaded(paths: string | Iterable<string>): void {
    for (const p of typeof paths === 'string' ? [paths] : paths) {
      const key = normalizeTreePath(p)?.key;
      if (key) this.loadedDirs.add(key);
    }
  }

  /** A folder that opens with nothing under it, never loaded and not loading. */
  private needsLoad(key: string): boolean {
    if (!this.loader || this.loadedDirs.has(key) || this.loads.has(key)) return false;
    const m = this.current;
    const id = m.find(key);
    return id > ROOT && m.isDir(id) && m.childrenOf(id).length === 0;
  }

  /** Start a load for every open folder that needs one. */
  private loadOpened(): void {
    if (!this.loader) return;
    for (const key of this.current.expandedPaths()) if (this.needsLoad(key)) void this.load(key);
  }

  /**
   * Load one folder's children now (also what opening an unloaded folder
   * does). Resolves once they are in the tree. One load per folder at a time;
   * a loaded folder is not loaded again.
   */
  load(path: string): Promise<void> {
    const key = normalizeTreePath(path)?.key;
    const loader = this.loader;
    if (!key || !loader || this.loadedDirs.has(key) || this.loads.has(key)) return Promise.resolve();
    const entry: { slow: boolean; timer: ReturnType<typeof setTimeout> | null } = { slow: false, timer: null };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.loads.get(key) !== entry) return;
      entry.slow = true;
      this.commit();
    }, this.loadingDelayMs);
    this.loads.set(key, entry);
    const finish = () => {
      if (entry.timer) clearTimeout(entry.timer);
      if (this.loads.get(key) === entry) this.loads.delete(key);
    };
    let pending: Promise<Iterable<string> | void>;
    try {
      pending = Promise.resolve(loader(key));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (children) => {
        finish();
        this.loadedDirs.add(key);
        const list = children ? [...children] : [];
        // Added under the folder whatever was opened or closed meanwhile; a folder closed during the load stays closed.
        if (list.length === 0 || !this.add(list)) this.commit();
      },
      () => {
        finish();
        // Not loaded: the folder closes again, and the next open tries again.
        if (!this.collapse(key)) this.commit();
      },
    );
  }

  collapse(path: string): boolean {
    return this.run({ kind: 'expansion', run: (m) => m.collapse(m.find(path)) });
  }

  /** Open a closed folder or close an open one, as the tree on screen shows it. */
  toggle(path: string): boolean {
    const id = this.current.find(path);
    // Resolved here, so the index being built gets the same open or close the
    // person saw. While a filter waits for the index there is nothing on
    // screen to resolve against: the index decides.
    if (id > ROOT && !this.filterPending) return this.current.isExpanded(id) ? this.collapse(path) : this.expand(path);
    return this.run({
      kind: 'expansion',
      run: (m) => {
        const n = m.find(path);
        if (n <= ROOT) return false;
        return m.isExpanded(n) ? m.collapse(n) : m.expand(n);
      },
    });
  }

  /**
   * Expand everything (no path), or a folder, its ancestors and every folder
   * under it. One pass and one render.
   */
  expandAll(path?: string): boolean {
    const changed = this.run({
      kind: 'expansion',
      run: (m) => {
        if (path === undefined) return m.expandAll();
        const id = m.find(path);
        if (id <= ROOT) return false;
        const a = m.expandAncestors(id);
        const b = m.expandAll(id);
        return a || b;
      },
    });
    // Lazy folders opened here load their own children (one level: what they hold arrives closed).
    this.loadOpened();
    return changed;
  }

  /**
   * Open every folder beside `path` (its siblings, itself included): the
   * tree pattern's `*` key. One update; lazy folders among them load.
   */
  expandSiblings(path: string): boolean {
    const changed = this.run({
      kind: 'expansion',
      run: (m) => {
        const id = m.find(path);
        if (id <= ROOT) return false;
        let any = false;
        for (const c of m.childrenOf(m.parentOf(id))) {
          // A locked folder stays shut: the host refuses what is in it.
          if (m.isShown(c) && m.isDir(c) && this.badgeMap.get(m.pathOf(c))?.locked === undefined) any = m.expand(c) || any;
        }
        return any;
      },
    });
    this.loadOpened();
    return changed;
  }

  /** Collapse everything (no path), or a folder and every folder under it. */
  collapseAll(path?: string): boolean {
    return this.run({
      kind: 'expansion',
      run: (m) => {
        if (path === undefined) return m.collapseAll();
        const id = m.find(path);
        return id > ROOT ? m.collapseAll(id) : false;
      },
    });
  }

  /**
   * Expand the folders above `path` so its row shows. Returns its row, or -1
   * when it is not in the tree or the filter hides it (nothing is opened then).
   */
  reveal(path: string): number {
    const m = this.current;
    const id = m.find(path);
    if (m.filtered && (id <= ROOT || !m.isShown(id))) return -1;
    this.run({
      kind: 'expansion',
      run: (model) => {
        const n = model.find(path);
        if (n <= ROOT || (model.filtered && !model.isShown(n))) return false;
        return model.expandAncestors(n);
      },
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
    this.building?.ops.push({ kind: 'values', values });
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
