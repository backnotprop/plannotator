/**
 * DOM-gated tests (DOM_TESTS=1) for the auto-mark-viewed binding. Registered
 * in .github/workflows/test.yml's "Run UI seam-contract + DOM tests" step.
 *
 * The decision core is covered purely in utils/autoViewed.test.ts. What this
 * file guards is the wiring the core cannot see:
 *
 *  - a read-through of a PR firing one /api/pr-viewed request per file
 *    (the endpoint's body already takes an array, and the batcher exists
 *    precisely so a 40-file review is not 40 POSTs);
 *  - the off switch reaching the pipeline at all;
 *  - the un-view suppression set (owned by the App because it rides the
 *    draft) actually reaching the core;
 *  - Rule 2: opening a file in the single-file panel marking it, and moving
 *    on from it NOT marking it;
 *  - Rule 4: a suspended session (guide takeover / commit detour) marking.
 *
 * Dwell and batch windows are compressed through the hook's documented test
 * overrides so this runs in milliseconds.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAutoViewed, type UseAutoViewedOptions, type UseAutoViewedResult } from './useAutoViewed';

const hasDom = typeof document !== 'undefined';

const DWELL_MS = 20;
// Comfortably longer than a full three-file read-through below, so the batch
// window is what groups the marks rather than the test's own pacing.
const BATCH_MS = 400;

let root: Root | null = null;
let host: HTMLElement | null = null;

function Harness({ opts, out }: { opts: UseAutoViewedOptions; out: { current: UseAutoViewedResult | null } }) {
  out.current = useAutoViewed(opts);
  return null;
}

interface Session {
  api: { current: UseAutoViewedResult | null };
  rerender: (opts: UseAutoViewedOptions) => Promise<void>;
}

async function mount(opts: UseAutoViewedOptions): Promise<Session> {
  host = document.createElement('div');
  document.body.appendChild(host);
  const out: { current: UseAutoViewedResult | null } = { current: null };
  let current = opts;
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness opts={current} out={out} />);
  });
  return {
    api: out,
    rerender: async (next) => {
      current = next;
      await act(async () => { root!.render(<Harness opts={current} out={out} />); });
    },
  };
}

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function baseOptions(over: Partial<UseAutoViewedOptions> = {}): UseAutoViewedOptions {
  return {
    enabled: true,
    suspended: false,
    viewedFiles: new Set<string>(),
    suppressedFiles: new Set<string>(),
    onMark: () => {},
    singleFileReadingFile: null,
    snapshotKey: 'snap-1',
    dwellMs: DWELL_MS,
    syncBatchMs: BATCH_MS,
    ...over,
  };
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('useAutoViewed', () => {
  test('three files read through in one pass produce ONE platform sync carrying all three', async () => {
    const marked: string[] = [];
    const synced: string[][] = [];
    const s = await mount(baseOptions({
      onMark: (paths) => marked.push(...paths),
      onSyncPlatformViewed: (paths) => synced.push(paths),
    }));

    for (const [file, next] of [['a.ts', 'b.ts'], ['b.ts', 'c.ts'], ['c.ts', 'd.ts']] as const) {
      act(() => s.api.current!.handleReadingFileChange(file));
      await wait(DWELL_MS + 10);
      act(() => {
        s.api.current!.handleReadingFileChange(next);
        s.api.current!.handleFileScrolledPast(file);
      });
    }

    // The checkmarks appear immediately — only the remote sync waits.
    expect(marked).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(synced).toEqual([]);
    await wait(BATCH_MS + 30);
    expect(synced).toEqual([['a.ts', 'b.ts', 'c.ts']]);
  });

  test('the off switch severs the pipeline', async () => {
    const marked: string[] = [];
    const s = await mount(baseOptions({ enabled: false, onMark: (p) => marked.push(...p) }));
    act(() => s.api.current!.handleReadingFileChange('a.ts'));
    await wait(DWELL_MS + 10);
    act(() => {
      s.api.current!.handleReadingFileChange('b.ts');
      s.api.current!.handleFileScrolledPast('a.ts');
    });
    expect(marked).toEqual([]);
  });

  test('a suppressed file is never re-marked (Rule 3 reaches the core)', async () => {
    const marked: string[] = [];
    const s = await mount(baseOptions({
      suppressedFiles: new Set(['a.ts']),
      onMark: (p) => marked.push(...p),
    }));
    act(() => s.api.current!.handleReadingFileChange('a.ts'));
    await wait(DWELL_MS + 10);
    act(() => {
      s.api.current!.handleReadingFileChange('b.ts');
      s.api.current!.handleFileScrolledPast('a.ts');
    });
    expect(marked).toEqual([]);
  });

  test('a suspended session marks nothing and accrues no reading time (Rule 4)', async () => {
    const marked: string[] = [];
    const s = await mount(baseOptions({ suspended: true, onMark: (p) => marked.push(...p) }));
    act(() => s.api.current!.handleReadingFileChange('a.ts'));
    await wait(DWELL_MS * 3);
    act(() => {
      s.api.current!.handleReadingFileChange('b.ts');
      s.api.current!.handleFileScrolledPast('a.ts');
    });
    expect(marked).toEqual([]);

    // Leaving the detour resumes from NOW, so the time spent in it is not
    // banked into an instant mark on the next pass.
    await s.rerender(baseOptions({ suspended: false, onMark: (p) => marked.push(...p) }));
    act(() => {
      s.api.current!.handleReadingFileChange('c.ts');
      s.api.current!.handleFileScrolledPast('b.ts');
    });
    expect(marked).toEqual([]);
  });

  test('the single-file panel marks on navigate-away, never on open (Rule 2)', async () => {
    const marked: string[] = [];
    const s = await mount(baseOptions({ onMark: (p) => marked.push(...p) }));

    await s.rerender(baseOptions({ singleFileReadingFile: 'a.ts', onMark: (p) => marked.push(...p) }));
    await wait(DWELL_MS + 10);
    // Opening it and sitting on it must not check it off — the reviewer has
    // not moved on yet.
    expect(marked).toEqual([]);

    await s.rerender(baseOptions({ singleFileReadingFile: 'b.ts', onMark: (p) => marked.push(...p) }));
    expect(marked).toEqual(['a.ts']);

    // A 2-second glance at b.ts is not a review of it.
    await s.rerender(baseOptions({ singleFileReadingFile: 'c.ts', onMark: (p) => marked.push(...p) }));
    expect(marked).toEqual(['a.ts']);
  });

  test('a new diff snapshot clears dwell so nothing marks on first contact', async () => {
    // Guards dwell leaking across a diff switch, which would check files off
    // in the new diff the instant they were passed.
    const marked: string[] = [];
    const s = await mount(baseOptions({ onMark: (p) => marked.push(...p) }));
    act(() => s.api.current!.handleReadingFileChange('a.ts'));
    await wait(DWELL_MS + 10);
    await s.rerender(baseOptions({ snapshotKey: 'snap-2', onMark: (p) => marked.push(...p) }));
    act(() => {
      s.api.current!.handleReadingFileChange('b.ts');
      s.api.current!.handleFileScrolledPast('a.ts');
    });
    expect(marked).toEqual([]);
  });

  test('a file parked at the bottom of the diff matures without further scrolling', async () => {
    // reportVisibleFile only runs on scroll, so the LAST file — the one that
    // can never scroll out above — would otherwise never reach its dwell.
    const marked: string[] = [];
    const s = await mount(baseOptions({ onMark: (p) => marked.push(...p) }));
    act(() => s.api.current!.handleReadingFileChange('last.ts'));
    // The at-bottom emission arrives immediately, well before the floor.
    act(() => s.api.current!.handleFileScrolledPast('last.ts'));
    expect(marked).toEqual([]);
    await wait(DWELL_MS + 60);
    expect(marked).toEqual(['last.ts']);
  });
});
