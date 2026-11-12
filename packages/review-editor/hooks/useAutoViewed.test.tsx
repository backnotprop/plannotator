import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAutoViewed, type UseAutoViewedOptions, type UseAutoViewedResult } from './useAutoViewed';

const hasDom = typeof document !== 'undefined';

const DWELL_MS = 20;
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

let clock = 0;
async function pass(ms: number) {
  clock += ms;
  setSystemTime(clock);
  await wait(ms);
}

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

beforeEach(() => {
  clock = Date.parse('2026-01-01T00:00:00.000Z');
  setSystemTime(clock);
});

afterEach(async () => {
  setSystemTime();
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
      await pass(DWELL_MS + 10);
      act(() => {
        s.api.current!.handleReadingFileChange(next);
        s.api.current!.handleFileScrolledPast(file);
      });
    }

    expect(marked).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(synced).toEqual([]);
    await wait(BATCH_MS + 30);
    expect(synced).toEqual([['a.ts', 'b.ts', 'c.ts']]);
  });

  test('the off switch severs the pipeline', async () => {
    const marked: string[] = [];
    const s = await mount(baseOptions({ enabled: false, onMark: (p) => marked.push(...p) }));
    act(() => s.api.current!.handleReadingFileChange('a.ts'));
    await pass(DWELL_MS + 10);
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
    await pass(DWELL_MS + 10);
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
    await pass(DWELL_MS * 3);
    act(() => {
      s.api.current!.handleReadingFileChange('b.ts');
      s.api.current!.handleFileScrolledPast('a.ts');
    });
    expect(marked).toEqual([]);

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
    await pass(DWELL_MS + 10);
    expect(marked).toEqual([]);

    await s.rerender(baseOptions({ singleFileReadingFile: 'b.ts', onMark: (p) => marked.push(...p) }));
    expect(marked).toEqual(['a.ts']);

    await pass(DWELL_MS / 2);
    await s.rerender(baseOptions({ singleFileReadingFile: 'c.ts', onMark: (p) => marked.push(...p) }));
    expect(marked).toEqual(['a.ts']);
  });

  test('a new diff snapshot clears dwell so nothing marks on first contact', async () => {
    const marked: string[] = [];
    const s = await mount(baseOptions({ onMark: (p) => marked.push(...p) }));
    act(() => s.api.current!.handleReadingFileChange('a.ts'));
    await pass(DWELL_MS + 10);
    await s.rerender(baseOptions({ snapshotKey: 'snap-2', onMark: (p) => marked.push(...p) }));
    act(() => {
      s.api.current!.handleReadingFileChange('b.ts');
      s.api.current!.handleFileScrolledPast('a.ts');
    });
    expect(marked).toEqual([]);
  });

  test('a file parked at the bottom of the diff matures without further scrolling', async () => {
    const marked: string[] = [];
    const s = await mount(baseOptions({ onMark: (p) => marked.push(...p) }));
    act(() => s.api.current!.handleReadingFileChange('last.ts'));
    act(() => s.api.current!.handleFileScrolledPast('last.ts'));
    expect(marked).toEqual([]);
    await pass(DWELL_MS + 60);
    expect(marked).toEqual(['last.ts']);
  });
});
