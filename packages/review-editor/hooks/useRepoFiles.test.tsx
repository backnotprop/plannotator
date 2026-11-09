/**
 * `useRepoFiles`: the repository is listed only while All files is chosen,
 * again for a new snapshot, and again after the live stream says the disk
 * changed; lazy listings ask for one folder at a time.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRepoFiles, type RepoFiles } from './useRepoFiles';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

class FakeEventSource {
  static last: FakeEventSource | null = null;
  static opened = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.last = this;
    FakeEventSource.opened += 1;
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function fakeFetch(answer: (url: string) => unknown) {
  const calls: string[] = [];
  const impl = (async (input: string) => {
    calls.push(input);
    return new Response(JSON.stringify(answer(input)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const listing = (paths: string[], extra: Record<string, unknown> = {}) => ({
  available: true,
  revision: { kind: 'worktree', label: 'working tree' },
  total: paths.length,
  live: true,
  paths,
  ...extra,
});

async function render(props: { enabled: boolean; snapshotId?: string }, fetchImpl: typeof fetch) {
  const latest: { current: RepoFiles | null } = { current: null };
  const Probe = (p: { enabled: boolean; snapshotId?: string }) => {
    latest.current = useRepoFiles({ ...p, fetchImpl, eventSourceImpl: FakeEventSource as unknown as typeof EventSource });
    return null;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Probe {...props} />));
  return {
    latest,
    rerender: async (next: { enabled: boolean; snapshotId?: string }) => {
      await act(async () => root?.render(<Probe {...next} />));
    },
  };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe.skipIf(!hasDom)('useRepoFiles', () => {
  test('lists nothing until All files is chosen, then once per snapshot', async () => {
    const net = fakeFetch(() => listing(['a.ts', 'b.ts']));
    const view = await render({ enabled: false, snapshotId: 's1' }, net.impl);
    await flush();
    expect(net.calls).toEqual([]);
    expect(view.latest.current?.state.status).toBe('idle');

    await view.rerender({ enabled: true, snapshotId: 's1' });
    await flush();
    expect(net.calls).toEqual(['/api/repo-files?snapshot=s1']);
    const state = view.latest.current!.state;
    expect(state.status).toBe('ready');
    if (state.status === 'ready') expect(state.paths).toEqual(['a.ts', 'b.ts']);

    // Hidden and shown again: the tree is kept on screen and, since nothing
    // watched the disk meanwhile, a live listing is fetched again quietly.
    await view.rerender({ enabled: false, snapshotId: 's1' });
    await view.rerender({ enabled: true, snapshotId: 's1' });
    expect(view.latest.current!.state.status).toBe('ready');
    await flush();
    expect(net.calls).toEqual(['/api/repo-files?snapshot=s1', '/api/repo-files?snapshot=s1']);

    await view.rerender({ enabled: true, snapshotId: 's2' });
    await flush();
    expect(net.calls).toEqual(['/api/repo-files?snapshot=s1', '/api/repo-files?snapshot=s1', '/api/repo-files?snapshot=s2']);
  });

  test('a live listing follows the disk: a changed event lists again', async () => {
    let paths = ['a.ts'];
    const net = fakeFetch(() => listing(paths, { onDisk: paths.length > 1 ? { 'new.ts': 'A' } : undefined }));
    const view = await render({ enabled: true, snapshotId: 's1' }, net.impl);
    await flush();
    expect(FakeEventSource.last?.url).toBe('/api/repo-files/stream?snapshot=s1');
    paths = ['a.ts', 'new.ts'];
    await act(async () => FakeEventSource.last?.emit({ type: 'changed' }));
    await flush();
    const state = view.latest.current!.state;
    expect(net.calls).toHaveLength(2);
    if (state.status !== 'ready') throw new Error('not ready');
    expect(state.paths).toEqual(['a.ts', 'new.ts']);
    expect(state.onDisk).toEqual({ 'new.ts': 'A' });
    expect(state.liveVersion).toBe(1);
  });

  test('a listing that does not change opens no stream', async () => {
    const before = FakeEventSource.opened;
    const net = fakeFetch(() => listing(['a.ts'], { live: false, revision: { kind: 'commit', label: 'abc1234' } }));
    await render({ enabled: true, snapshotId: 's1' }, net.impl);
    await flush();
    expect(FakeEventSource.opened).toBe(before);
  });

  test('a lazy listing loads folders on request, once each', async () => {
    const net = fakeFetch((url) =>
      url.includes('dir=src')
        ? { ...listing([]), paths: undefined, lazy: true, dir: 'src', entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }] }
        : { ...listing([]), paths: undefined, total: 300_000, lazy: true, dir: '', entries: [{ name: 'src', path: 'src', type: 'dir', files: 1 }] },
    );
    const view = await render({ enabled: true, snapshotId: 's1' }, net.impl);
    await flush();
    await act(async () => {
      view.latest.current!.loadDir('src');
      view.latest.current!.loadDir('src');
    });
    await flush();
    expect(net.calls).toEqual(['/api/repo-files?snapshot=s1', '/api/repo-files?snapshot=s1&dir=src']);
    const state = view.latest.current!.state;
    if (state.status !== 'ready') throw new Error('not ready');
    expect(state.paths).toBeNull();
    expect(state.dirs.get('src')?.map((entry) => entry.path)).toEqual(['src/a.ts']);
  });

  test('says when the session cannot list', async () => {
    const net = fakeFetch(() => ({ available: false, reason: 'static-patch', message: 'A patch file has no repository to list.' }));
    const view = await render({ enabled: true, snapshotId: 's1' }, net.impl);
    await flush();
    expect(view.latest.current!.state).toEqual({ status: 'unavailable', reason: 'static-patch', message: 'A patch file has no repository to list.' });
  });
});
