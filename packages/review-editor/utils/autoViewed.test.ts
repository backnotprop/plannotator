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
    const tracker = new AutoViewedTracker();
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    let now = 0;
    const marked: string[] = [];
    tracker.readingFileChanged(files[0], now);
    for (let i = 1; i < files.length; i++) {
      now += 60;
      tracker.readingFileChanged(files[i], now);
      if (tracker.filePassed(files[i - 1], now) === 'marked') marked.push(files[i - 1]);
    }
    expect(marked).toEqual([]);
  });

  test('a read-through marks; scrolling back up never does', () => {
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0);
    tracker.readingFileChanged('b.ts', AUTO_VIEW_DWELL_MS + 50);
    expect(tracker.filePassed('a.ts', AUTO_VIEW_DWELL_MS + 50)).toBe('marked');

    const upward = new AutoViewedTracker();
    upward.readingFileChanged('b.ts', 0);
    upward.readingFileChanged('a.ts', AUTO_VIEW_DWELL_MS + 50);
    expect(upward.dwellFor('b.ts')).toBeGreaterThanOrEqual(AUTO_VIEW_DWELL_MS);
  });

  test('dwell is cumulative across visits', () => {
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0);
    tracker.readingFileChanged('b.ts', 600);
    expect(tracker.filePassed('a.ts', 600)).toBe('dwell');
    tracker.readingFileChanged('a.ts', 900);
    tracker.readingFileChanged('b.ts', 1600);
    expect(tracker.filePassed('a.ts', 1600)).toBe('marked');
  });

  test('a collapsed card accrues no dwell', () => {
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('bun.lock', 0, { countable: false });
    tracker.readingFileChanged('src/app.ts', 10_000);
    expect(tracker.dwellFor('bun.lock')).toBe(0);
    expect(tracker.filePassed('bun.lock', 10_000)).toBe('dwell');
  });

  test('disabled produces zero marks from input that otherwise marks', () => {
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
    const tracker = new AutoViewedTracker({ enabled: false });
    tracker.readingFileChanged('a.ts', 0);
    tracker.tick(AUTO_VIEW_DWELL_MS + 500);
    expect(tracker.dwellFor('a.ts')).toBe(0);

    tracker.setEnabled(true, AUTO_VIEW_DWELL_MS + 500);
    expect(tracker.filePassed('a.ts', AUTO_VIEW_DWELL_MS + 500)).toBe('dwell');

    tracker.readingFileChanged('a.ts', AUTO_VIEW_DWELL_MS + 500);
    tracker.readingFileChanged('b.ts', 2 * AUTO_VIEW_DWELL_MS + 600);
    expect(tracker.filePassed('a.ts', 2 * AUTO_VIEW_DWELL_MS + 600)).toBe('marked');
  });

  test('un-viewing suppresses auto-view until the file is viewed by hand again', () => {
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
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0, { countable: false });
    tracker.readingFileChanged('a.ts', 30_000, { countable: true });
    expect(tracker.dwellFor('a.ts')).toBe(0);
    expect(tracker.filePassed('a.ts', 30_500)).toBe('dwell');
  });

  test('navigating away from a single-file panel marks the file it left', () => {
    const tracker = new AutoViewedTracker();
    tracker.readingFileChanged('a.ts', 0);
    expect(tracker.fileNavigatedAway('a.ts', 400)).toBe('dwell');
    tracker.readingFileChanged('a.ts', 400);
    tracker.readingFileChanged('b.ts', 400 + AUTO_VIEW_DWELL_MS);
    expect(tracker.fileNavigatedAway('a.ts', 400 + AUTO_VIEW_DWELL_MS)).toBe('marked');
  });
});

describe('createViewedSyncBatcher', () => {
  test('marks inside the window go out as ONE call carrying every path', async () => {
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
    { path: 'a.ts', patch: 'PATCH-A-V2' },
    { path: 'b.ts', patch: 'PATCH-B-V1' },
  ];

  test('only the file whose patch changed loses its checkmark', () => {
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
    expect(resolveDiffSwitchUnviews({
      ...base,
      contentRefresh: false,
      requestedDiffType: 'commit:abc1234',
      activeDiffType: 'since-base',
      requestedBase: 'origin/main',
      activeBase: 'origin/main',
      appliedDiffType: 'commit:abc1234',
    })).toEqual([]);
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
