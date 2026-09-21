/**
 * Auto-mark-viewed decision core.
 *
 * One invariant drives both review surfaces: a file becomes auto-viewed when
 * the reviewer MOVES ON from it after its content was on screen long enough to
 * have been read. Arriving at a file never marks it; leaving it downward does.
 *
 * This module owns only the decision — no DOM, no React, no clock of its own.
 * Every entry point takes the current time in milliseconds so the whole
 * machine is unit-testable without timers. The geometry ("has this file
 * genuinely scrolled out above?") is decided by the caller, which already has
 * CodeView's accessors; what lives here is dwell bookkeeping, the suppression
 * contract, and the on/off switch.
 */

/**
 * Minimum time a file must have been the reported reading file before passing
 * it can mark it viewed. Cumulative across visits within one diff snapshot.
 *
 * Without a floor, a momentum flick to the bottom makes every intermediate
 * file transiently active (the reporter is rAF-coalesced) and the entire
 * review would check itself off in one gesture. A starting value, not a
 * contract.
 */
export const AUTO_VIEW_DWELL_MS = 1000;

/** Why a pass attempt did not mark, for callers that want to react. */
export type AutoViewOutcome =
  /** Marked — the caller should apply the viewed state. */
  | 'marked'
  /** Off switch: the pipeline is severed. */
  | 'disabled'
  /** The reviewer un-viewed this file; auto-view never re-marks it. */
  | 'suppressed'
  /** Seen, but not for long enough yet. */
  | 'dwell';

export interface AutoViewedTrackerOptions {
  enabled?: boolean;
  /** Override the dwell floor (tests). */
  dwellMs?: number;
}

export class AutoViewedTracker {
  private readonly dwellMs: number;
  private enabled: boolean;
  /** Cumulative reading time per path, cleared on every snapshot boundary. */
  private readonly dwell = new Map<string, number>();
  /** Paths the reviewer manually un-viewed. Survives snapshot resets. */
  private readonly suppressed = new Set<string>();
  private activePath: string | null = null;
  private activeSince = 0;
  /**
   * Whether the active file's time counts. A collapsed card shows a folded
   * header and no content, so parking on one accrues nothing — otherwise
   * expanding a long-parked collapsed file and immediately scrolling past it
   * would mark content that was never rendered.
   */
  private activeCountable = true;

  constructor(options: AutoViewedTrackerOptions = {}) {
    this.dwellMs = options.dwellMs ?? AUTO_VIEW_DWELL_MS;
    this.enabled = options.enabled ?? true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Flip the off switch. Commits first, so disabling banks the reading time
   * that was legitimately accrued up to this instant, and enabling starts the
   * current file's clock from now rather than crediting the disabled stretch
   * (see `commit`).
   */
  setEnabled(enabled: boolean, nowMs: number): void {
    this.commit(nowMs);
    this.enabled = enabled;
  }

  /** The file the reviewer is currently reading, or null when there is none. */
  getReadingFile(): string | null {
    return this.activePath;
  }

  /** Cumulative dwell for a path in this snapshot. */
  dwellFor(path: string): number {
    return this.dwell.get(path) ?? 0;
  }

  /** How much longer `path` must stay active before a pass could mark it. */
  remainingDwell(path: string): number {
    return Math.max(0, this.dwellMs - this.dwellFor(path));
  }

  /**
   * The reported reading file changed (all-files scroll) or the single-file
   * panel switched. `countable: false` marks the incoming file as one whose
   * time must not accrue (a collapsed card).
   */
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

  /** Fold elapsed time into the active file without changing it. */
  tick(nowMs: number): void {
    this.commit(nowMs);
  }

  /**
   * The reviewer scrolled DOWN past `path` on the all-files surface. The
   * caller has already verified the direction, the geometry, and that the
   * card was expanded.
   */
  filePassed(path: string, nowMs: number): AutoViewOutcome {
    return this.tryMark(path, nowMs);
  }

  /**
   * The all-files surface is scrolled to its bottom with `path` active. The
   * last file can never scroll out above, so reaching the end of the diff is
   * its completion signal.
   */
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

  /**
   * The reviewer un-viewed a file. That gesture means "come back to this", so
   * auto-view must never re-check it; a system that immediately re-marks it is
   * hostile. Suppression survives snapshot resets and rides the draft.
   */
  suppress(path: string): void {
    this.suppressed.add(path);
  }

  /** Manually marking a file viewed clears its suppression. */
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

  /**
   * Replace the suppression set wholesale. Used where the set is owned
   * elsewhere (it rides the review draft) and mirrored in.
   */
  setSuppressed(paths: Iterable<string>): void {
    this.suppressed.clear();
    for (const path of paths) this.suppressed.add(path);
  }

  /**
   * A new diff snapshot is on screen. Dwell is per-snapshot: carrying it over
   * would let a file the reviewer read in the previous diff mark itself the
   * instant it is passed in the new one. Suppression is NOT cleared — the
   * "come back to this" gesture is about the file, not the snapshot.
   */
  resetSnapshot(nowMs = 0): void {
    this.dwell.clear();
    this.activePath = null;
    this.activeSince = nowMs;
    this.activeCountable = true;
  }

  private commit(nowMs: number): void {
    // Disabled means fully inert, not merely "does not mark": banking dwell
    // while the switch is off would let turning it back on mid-read check the
    // current file off instantly, on time the reviewer spent with the feature
    // deliberately disabled. activeSince still advances, so enabling starts a
    // fresh clock rather than replaying the gap.
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

/**
 * Batches auto-view marks into one platform sync request.
 *
 * `/api/pr-viewed` already takes a `filePaths` array; without batching, a
 * read-through of a 40-file PR fires 40 POSTs. The viewed STATE is applied
 * immediately by the caller — only the remote sync waits.
 */
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


/**
 * Rule 5 — which viewed files a newly applied patch should UN-view.
 *
 * A checkmark on content the agent has since rewritten is actively
 * misleading, which is why GitHub drops it too. Gated on the auto-view
 * setting rather than applied unconditionally: with auto-view OFF, today's
 * manual semantics must stay byte-identical — a reviewer who hand-checked
 * forty files and then pulls a one-line change keeps all forty.
 *
 * Un-viewing here never suppresses: new content is a fresh auto-view
 * opportunity, not a "come back to this" gesture.
 *
 * Files absent from the new patch keep their viewed state (a diff-type switch
 * can hide a file the reviewer already checked off, and it should still be
 * checked off when it comes back).
 */
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

/**
 * Which transitions Rule 5 is allowed to act on, and what it un-views there.
 *
 * `resolveContentChangedUnviews` answers "what changed?"; this answers the
 * question that has to come first, "is this even a moment where a per-path
 * patch delta MEANS the content changed?" They are separate because every
 * diff transition funnels through one apply path in the review app: the
 * staleness refresh, a base-branch switch, the hide-whitespace toggle and a
 * `commit:<sha>` detour all land there. Treating them alike un-views files
 * merely because the reviewer looked at a historical commit or folded
 * whitespace out, which is the opposite of what Rule 5 is for and contradicts
 * Rule 4's "a commit detour is inert".
 *
 * So the call site must OPT IN (`contentRefresh`), and even then this
 * re-checks the identity of the diff: same selection, same base, and never a
 * commit-family diff on either side of the transition. A future caller that
 * passes the flag on a diff-CHANGING switch still cannot un-view anything.
 */
export function resolveDiffSwitchUnviews(input: {
  enabled: boolean;
  /**
   * The call site declares this a re-fetch of the SAME diff selection, where a
   * per-path patch delta is a real content change (the staleness refresh and
   * the post-fetch base refresh). Never set by the whitespace toggle, whose
   * deltas are a presentation choice, nor by any switch that changes what is
   * being compared.
   */
  contentRefresh: boolean;
  requestedDiffType: string;
  activeDiffType: string;
  requestedBase?: string | null;
  activeBase?: string | null;
  /** The diff type the server actually applied. */
  appliedDiffType: string;
  /** True for `commit:<sha>` (and worktree-scoped variants of it). */
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
