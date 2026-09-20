/**
 * Auto-mark-viewed decision core.
 *
 * Every test here names a way the feature could quietly become wrong. The
 * whole point of auto-view is that the checkmarks stay trustworthy: a marker
 * that over-marks destroys the counter's meaning, and one that ignores the
 * reviewer's un-view is hostile.
 *
 * The core is clock-injected, so none of this needs timers or a DOM.
 */
import { describe, expect, test } from 'bun:test';
import {
  AUTO_VIEW_DWELL_MS,
  AutoViewedTracker,
  createViewedSyncBatcher,
  resolveContentChangedUnviews,
  resolveDiffSwitchUnviews,
} from './autoViewed';

describe('AutoViewedTracker', () => {
  test('a momentum flick through five files marks nothing', () => {
    // Guards the failure that would destroy trust in the checkmarks outright:
    // reportVisibleFile is rAF-coalesced, so one flick to the bottom makes
    // every intermediate file transiently active. Without the dwell floor the
    // whole review would check itself off in a single gesture.
    const tracker = new AutoViewedTracker();
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    let now = 0;
    const marked: string[] = [];
    tracker.readingFileChanged(files[0], now);
    for (let i = 1; i < files.length; i++) {
      now += 60; // one frame-ish per file — a flick, not a read
      tracker.readingFileChanged(files[i], now);
      if (tracker.filePassed(files[i - 1], now) === 'marked') marked.push(files[i - 1]);
    }
    expect(marked).toEqual([]);
  });

  test('a read-through marks; scrolling back up never does', () => {
    // Guards direction inversion — the bug where scrolling UP checks off the
    // files below, which is the opposite of "moved on from".
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0);
    tracker.readingFileChanged('b.ts', AUTO_VIEW_DWELL_MS + 50);
    expect(tracker.filePassed('a.ts', AUTO_VIEW_DWELL_MS + 50)).toBe('marked');

    // Now back up to a.ts and sit there, then return to b.ts. b.ts itself was
    // never passed downward, so nothing above it may mark from that motion.
    // (The caller decides direction; the core is asked only about files the
    // caller says were passed, which is exactly why direction is asserted at
    // the emission site — see AllFilesCodeView.autoViewed.test.tsx.)
    const upward = new AutoViewedTracker();
    upward.readingFileChanged('b.ts', 0);
    upward.readingFileChanged('a.ts', AUTO_VIEW_DWELL_MS + 50);
    expect(upward.dwellFor('b.ts')).toBeGreaterThanOrEqual(AUTO_VIEW_DWELL_MS);
    // b.ts has the dwell, but an upward move is a return: the caller never
    // reports it as passed, so the marker stays silent for it.
  });

  test('dwell is cumulative across visits', () => {
    // Guards a refactor to "continuous dwell", which would silently raise the
    // bar: bouncing between two files while comparing them would then never
    // accrue enough time on either.
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0);
    tracker.readingFileChanged('b.ts', 600);
    expect(tracker.filePassed('a.ts', 600)).toBe('dwell');
    tracker.readingFileChanged('a.ts', 900);
    tracker.readingFileChanged('b.ts', 1600); // a.ts: 600 + 700 = 1300ms total
    expect(tracker.filePassed('a.ts', 1600)).toBe('marked');
  });

  test('a collapsed card accrues no dwell', () => {
    // Guards a generated/lockfile card marking itself from its folded header:
    // nobody reviewed a lockfile by parking on the strip that hides it.
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('bun.lock', 0, { countable: false });
    tracker.readingFileChanged('src/app.ts', 10_000);
    expect(tracker.dwellFor('bun.lock')).toBe(0);
    expect(tracker.filePassed('bun.lock', 10_000)).toBe('dwell');
  });

  test('disabled produces zero marks from input that otherwise marks', () => {
    // Guards the off switch not actually severing the pipeline.
    const enabled = new AutoViewedTracker({ enabled: true });
    const disabled = new AutoViewedTracker({ enabled: false });
    for (const tracker of [enabled, disabled]) {
      tracker.readingFileChanged('a.ts', 0);
      tracker.readingFileChanged('b.ts', AUTO_VIEW_DWELL_MS + 50);
    }
    expect(enabled.filePassed('a.ts', AUTO_VIEW_DWELL_MS + 50)).toBe('marked');
    expect(disabled.filePassed('a.ts', AUTO_VIEW_DWELL_MS + 50)).toBe('disabled');
  });

  test('time spent while disabled is not banked, so enabling cannot mark instantly', () => {
    // Guards "off" meaning merely "does not mark right now": if dwell kept
    // accruing behind the switch, turning the feature on mid-read would check
    // the current file off on the next pass using time the reviewer spent
    // with it deliberately disabled.
    const tracker = new AutoViewedTracker({ enabled: false });
    tracker.readingFileChanged('a.ts', 0);
    tracker.tick(AUTO_VIEW_DWELL_MS + 500); // a full dwell's worth, while off
    expect(tracker.dwellFor('a.ts')).toBe(0);

    tracker.setEnabled(true, AUTO_VIEW_DWELL_MS + 500);
    expect(tracker.filePassed('a.ts', AUTO_VIEW_DWELL_MS + 500)).toBe('dwell');

    // Only genuinely fresh reading time marks it.
    tracker.readingFileChanged('a.ts', AUTO_VIEW_DWELL_MS + 500);
    tracker.readingFileChanged('b.ts', 2 * AUTO_VIEW_DWELL_MS + 600);
    expect(tracker.filePassed('a.ts', 2 * AUTO_VIEW_DWELL_MS + 600)).toBe('marked');
  });

  test('un-viewing suppresses auto-view until the file is viewed by hand again', () => {
    // Guards the "come back to this" contract. An auto system that re-checks
    // the file the reviewer just un-checked is worse than no system.
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0);
    tracker.readingFileChanged('b.ts', AUTO_VIEW_DWELL_MS + 50);
    expect(tracker.filePassed('a.ts', AUTO_VIEW_DWELL_MS + 50)).toBe('marked');

    tracker.suppress('a.ts');
    tracker.readingFileChanged('a.ts', 5_000);
    tracker.readingFileChanged('b.ts', 5_000 + AUTO_VIEW_DWELL_MS + 50);
    expect(tracker.filePassed('a.ts', 5_000 + AUTO_VIEW_DWELL_MS + 50)).toBe('suppressed');

    tracker.unsuppress('a.ts');
    expect(tracker.filePassed('a.ts', 5_000 + AUTO_VIEW_DWELL_MS + 50)).toBe('marked');
  });

  test('a snapshot reset clears dwell but keeps suppression', () => {
    // Two failures in one: dwell leaking across a diff switch would mark files
    // in the NEW diff the instant they are passed (they were "read" in the old
    // one), and clearing suppression would resurrect auto-view on files the
    // reviewer explicitly parked.
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0);
    tracker.readingFileChanged('b.ts', AUTO_VIEW_DWELL_MS + 50);
    tracker.suppress('c.ts');

    tracker.resetSnapshot(AUTO_VIEW_DWELL_MS + 50);
    expect(tracker.dwellFor('a.ts')).toBe(0);
    expect(tracker.filePassed('a.ts', AUTO_VIEW_DWELL_MS + 50)).toBe('dwell');
    expect(tracker.isSuppressed('c.ts')).toBe(true);
  });

  test('a suspended stretch accrues no reading time', () => {
    // Guards Rule 4: time spent in the guide takeover or a commit detour is
    // not time spent reading the change under review.
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0, { countable: false });
    tracker.readingFileChanged('a.ts', 30_000, { countable: true });
    expect(tracker.dwellFor('a.ts')).toBe(0);
    expect(tracker.filePassed('a.ts', 30_500)).toBe('dwell');
  });

  test('navigating away from a single-file panel marks the file it left', () => {
    // Rule 2. Opening a file must not mark it (a misclick would check it off);
    // moving on after the dwell floor does.
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0);
    expect(tracker.fileNavigatedAway('a.ts', 400)).toBe('dwell'); // glanced and left
    tracker.readingFileChanged('a.ts', 400);
    tracker.readingFileChanged('b.ts', 400 + AUTO_VIEW_DWELL_MS);
    expect(tracker.fileNavigatedAway('a.ts', 400 + AUTO_VIEW_DWELL_MS)).toBe('marked');
  });
});

describe('createViewedSyncBatcher', () => {
  test('marks inside the window go out as ONE call carrying every path', async () => {
    // Guards a regression to request-per-file spam: a read-through of a
    // 40-file PR must not be 40 POSTs to /api/pr-viewed, whose body already
    // takes an array.
    const sent: string[][] = [];
    const batcher = createViewedSyncBatcher((paths) => sent.push(paths), { windowMs: 20 });
    batcher.add(['a.ts']);
    batcher.add(['b.ts']);
    batcher.add(['c.ts']);
    expect(sent).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sent).toEqual([['a.ts', 'b.ts', 'c.ts']]);
    batcher.dispose();
  });

  test('dispose drops a pending batch instead of firing after teardown', () => {
    const sent: string[][] = [];
    const batcher = createViewedSyncBatcher((paths) => sent.push(paths), { windowMs: 20 });
    batcher.add(['a.ts']);
    batcher.dispose();
    batcher.flush();
    expect(sent).toEqual([]);
  });
});

describe('resolveContentChangedUnviews (Rule 5)', () => {
  const previousFiles = [
    { path: 'a.ts', patch: 'PATCH-A-V1' },
    { path: 'b.ts', patch: 'PATCH-B-V1' },
  ];
  const nextFiles = [
    { path: 'a.ts', patch: 'PATCH-A-V2' }, // rewritten
    { path: 'b.ts', patch: 'PATCH-B-V1' }, // untouched
  ];

  test('only the file whose patch changed loses its checkmark', () => {
    // Guards the stale-checkmark bug: a check on content the agent just
    // rewrote claims a review that never happened.
    expect(
      resolveContentChangedUnviews({
        enabled: true,
        previousFiles,
        nextFiles,
        viewedFiles: new Set(['a.ts', 'b.ts']),
      }),
    ).toEqual(['a.ts']);
  });

  test('with auto-view off, nothing is un-viewed', () => {
    // Guards "the off state stays byte-identical to today": a reviewer who
    // hand-checked forty files and pulls a one-line change keeps all forty.
    expect(
      resolveContentChangedUnviews({
        enabled: false,
        previousFiles,
        nextFiles,
        viewedFiles: new Set(['a.ts', 'b.ts']),
      }),
    ).toEqual([]);
  });

  test('a file missing from the new patch keeps its viewed state', () => {
    // A diff-type switch can hide a file the reviewer already checked off; it
    // must still be checked off when it comes back.
    expect(
      resolveContentChangedUnviews({
        enabled: true,
        previousFiles,
        nextFiles: [{ path: 'a.ts', patch: 'PATCH-A-V1' }],
        viewedFiles: new Set(['a.ts', 'b.ts']),
      }),
    ).toEqual([]);
  });
});


describe('resolveDiffSwitchUnviews (Rule 5 call-site scope)', () => {
  // Every diff transition in the review app funnels through ONE apply path, so
  // what decides whether Rule 5 may act is the transition, not the patch
  // delta. These pin which transitions qualify. The delta logic itself is
  // covered above; here the content always changed, so a non-empty result
  // means "this transition was allowed to un-view".
  const isCommitDiffType = (diffType: string) => /(^|:)commit:/.test(diffType);
  const previousFiles = [
    { path: 'a.ts', patch: 'PATCH-A-V1' },
    { path: 'b.ts', patch: 'PATCH-B-V1' },
  ];
  const nextFiles = [
    { path: 'a.ts', patch: 'PATCH-A-V2' },
    { path: 'b.ts', patch: 'PATCH-B-V1' },
  ];
  const viewedFiles = new Set(['a.ts', 'b.ts']);
  const base = {
    enabled: true, isCommitDiffType, previousFiles, nextFiles, viewedFiles,
  };

  test('a staleness refresh with changed content un-views the changed file', () => {
    expect(resolveDiffSwitchUnviews({
      ...base,
      contentRefresh: true,
      requestedDiffType: 'since-base',
      activeDiffType: 'since-base',
      requestedBase: 'origin/main',
      activeBase: 'origin/main',
      appliedDiffType: 'since-base',
    })).toEqual(['a.ts']);
  });

  test('entering a commit detour un-views nothing', () => {
    // The Commits rail auto-opens HEAD on entry and every commit diff has
    // different per-path text, so an ungated Rule 5 stripped the checkmark off
    // every file that commit touched. A commit detour is documented as inert
    // (Rule 4) and reading a historical rendition is not reviewing the change.
    expect(resolveDiffSwitchUnviews({
      ...base,
      contentRefresh: false,
      requestedDiffType: 'commit:abc1234',
      activeDiffType: 'since-base',
      requestedBase: 'origin/main',
      activeBase: 'origin/main',
      appliedDiffType: 'commit:abc1234',
    })).toEqual([]);
    // Belt and braces: even a caller that wrongly opts in cannot un-view on a
    // commit-family diff, on either side of the transition.
    expect(resolveDiffSwitchUnviews({
      ...base,
      contentRefresh: true,
      requestedDiffType: 'commit:abc1234',
      activeDiffType: 'commit:abc1234',
      requestedBase: 'origin/main',
      activeBase: 'origin/main',
      appliedDiffType: 'commit:abc1234',
    })).toEqual([]);
  });

  test('the hide-whitespace toggle un-views nothing', () => {
    // It re-fetches the same selection and every patch legitimately differs,
    // but that delta is a presentation choice, not the content changing.
    expect(resolveDiffSwitchUnviews({
      ...base,
      contentRefresh: false,
      requestedDiffType: 'since-base',
      activeDiffType: 'since-base',
      requestedBase: 'origin/main',
      activeBase: 'origin/main',
      appliedDiffType: 'since-base',
    })).toEqual([]);
  });

  test('a diff-type or base switch un-views nothing, even if it opts in', () => {
    expect(resolveDiffSwitchUnviews({
      ...base,
      contentRefresh: true,
      requestedDiffType: 'uncommitted',
      activeDiffType: 'since-base',
      requestedBase: 'origin/main',
      activeBase: 'origin/main',
      appliedDiffType: 'uncommitted',
    })).toEqual([]);
    expect(resolveDiffSwitchUnviews({
      ...base,
      contentRefresh: true,
      requestedDiffType: 'since-base',
      activeDiffType: 'since-base',
      requestedBase: 'origin/develop',
      activeBase: 'origin/main',
      appliedDiffType: 'since-base',
    })).toEqual([]);
  });

  test('the off switch still severs it on an otherwise-qualifying refresh', () => {
    expect(resolveDiffSwitchUnviews({
      ...base,
      enabled: false,
      contentRefresh: true,
      requestedDiffType: 'since-base',
      activeDiffType: 'since-base',
      requestedBase: 'origin/main',
      activeBase: 'origin/main',
      appliedDiffType: 'since-base',
    })).toEqual([]);
  });
});
