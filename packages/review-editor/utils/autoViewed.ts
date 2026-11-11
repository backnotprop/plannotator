/**
 * One invariant drives both review surfaces: a file becomes auto-viewed when the reviewer MOVES ON
 * from it after its content was on screen long enough to have been read.
 */

export const AUTO_VIEW_DWELL_MS = 1000;

export type AutoViewOutcome =
  | 'marked'
  | 'disabled'
  /** The reviewer un-viewed this file; auto-view never re-marks it. */
  | 'suppressed'
  | 'dwell';

export interface AutoViewedTrackerOptions {
  enabled?: boolean;
  dwellMs?: number;
}

export class AutoViewedTracker {
  private readonly dwellMs: number;
  private enabled: boolean;
  private readonly dwell = new Map<string, number>();
  private readonly suppressed = new Set<string>();
  private activePath: string | null = null;
  private activeSince = 0;
  /**
   * A collapsed card shows a folded header and no content, so parking on one accrues nothing —
   * otherwise expanding a long-parked collapsed file and immediately scrolling past it would mark
   * content that was never rendered.
   */
  private activeCountable = true;

  constructor(options: AutoViewedTrackerOptions = {}) {
    this.dwellMs = options.dwellMs ?? AUTO_VIEW_DWELL_MS;
    this.enabled = options.enabled ?? true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean, nowMs: number): void {
    this.commit(nowMs);
    this.enabled = enabled;
  }

  getReadingFile(): string | null {
    return this.activePath;
  }

  dwellFor(path: string): number {
    return this.dwell.get(path) ?? 0;
  }

  /** How much longer `path` must stay active before a pass could mark it. */
  remainingDwell(path: string): number {
    return Math.max(0, this.dwellMs - this.dwellFor(path));
  }

  readingFileChanged(
    path: string | null,
    nowMs: number,
    options: { countable?: boolean } = {},
  ): void {
    this.commit(nowMs);
    this.activePath = path;
    this.activeSince = nowMs;
    this.activeCountable = options.countable ?? true;
  }

  tick(nowMs: number): void {
    this.commit(nowMs);
  }

  filePassed(path: string, nowMs: number): AutoViewOutcome {
    return this.tryMark(path, nowMs);
  }

  atBottom(path: string, nowMs: number): AutoViewOutcome {
    return this.tryMark(path, nowMs);
  }

  /**
   * The single-file diff panel moved off `path` (to another file, or closed).
   * Opening a file never marks it — only moving on does.
   */
  fileNavigatedAway(path: string, nowMs: number): AutoViewOutcome {
    return this.tryMark(path, nowMs);
  }

  suppress(path: string): void {
    this.suppressed.add(path);
  }

  unsuppress(path: string): void {
    this.suppressed.delete(path);
  }

  isSuppressed(path: string): boolean {
    return this.suppressed.has(path);
  }

  getSuppressed(): string[] {
    return [...this.suppressed];
  }

  /** Seed the suppression set (draft restore). Additive — never clears. */
  restoreSuppressed(paths: Iterable<string>): void {
    for (const path of paths) this.suppressed.add(path);
  }

  setSuppressed(paths: Iterable<string>): void {
    this.suppressed.clear();
    for (const path of paths) this.suppressed.add(path);
  }

  resetSnapshot(nowMs = 0): void {
    this.dwell.clear();
    this.activePath = null;
    this.activeSince = nowMs;
    this.activeCountable = true;
  }

  private commit(nowMs: number): void {
    if (this.enabled && this.activePath !== null && this.activeCountable && nowMs > this.activeSince) {
      this.dwell.set(this.activePath, this.dwellFor(this.activePath) + (nowMs - this.activeSince));
    }
    this.activeSince = nowMs;
  }

  private tryMark(path: string, nowMs: number): AutoViewOutcome {
    this.commit(nowMs);
    if (!this.enabled) return 'disabled';
    if (this.suppressed.has(path)) return 'suppressed';
    if (this.dwellFor(path) < this.dwellMs) return 'dwell';
    return 'marked';
  }
}

export const AUTO_VIEW_SYNC_BATCH_MS = 2000;

export interface ViewedSyncBatcher {
  add(paths: string[]): void;
  flush(): void;
  dispose(): void;
}

export function createViewedSyncBatcher(
  send: (paths: string[]) => void,
  options: { windowMs?: number } = {},
): ViewedSyncBatcher {
  const windowMs = options.windowMs ?? AUTO_VIEW_SYNC_BATCH_MS;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    send(batch);
  };

  return {
    add(paths: string[]) {
      for (const path of paths) pending.add(path);
      if (pending.size === 0 || timer !== null) return;
      timer = setTimeout(flush, windowMs);
    },
    flush,
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
    },
  };
}


export function resolveContentChangedUnviews(input: {
  enabled: boolean;
  previousFiles: ReadonlyArray<{ path: string; patch: string }>;
  nextFiles: ReadonlyArray<{ path: string; patch: string }>;
  viewedFiles: ReadonlySet<string>;
}): string[] {
  if (!input.enabled || input.viewedFiles.size === 0) return [];
  const previousByPath = new Map<string, string>();
  for (const file of input.previousFiles) {
    if (!previousByPath.has(file.path)) previousByPath.set(file.path, file.patch);
  }
  const changed: string[] = [];
  for (const file of input.nextFiles) {
    if (!input.viewedFiles.has(file.path)) continue;
    const before = previousByPath.get(file.path);
    if (before !== undefined && before !== file.patch) changed.push(file.path);
  }
  return changed;
}

export function resolveDiffSwitchUnviews(input: {
  enabled: boolean;
  contentRefresh: boolean;
  requestedDiffType: string;
  activeDiffType: string;
  requestedBase?: string | null;
  activeBase?: string | null;
  appliedDiffType: string;
  isCommitDiffType: (diffType: string) => boolean;
  previousFiles: ReadonlyArray<{ path: string; patch: string }>;
  nextFiles: ReadonlyArray<{ path: string; patch: string }>;
  viewedFiles: ReadonlySet<string>;
}): string[] {
  if (!input.contentRefresh) return [];
  if (input.requestedDiffType !== input.activeDiffType) return [];
  if ((input.requestedBase ?? null) !== (input.activeBase ?? null)) return [];
  if (input.isCommitDiffType(input.requestedDiffType)) return [];
  if (input.isCommitDiffType(input.appliedDiffType)) return [];
  return resolveContentChangedUnviews({
    enabled: input.enabled,
    previousFiles: input.previousFiles,
    nextFiles: input.nextFiles,
    viewedFiles: input.viewedFiles,
  });
}
