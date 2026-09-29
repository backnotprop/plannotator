import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useReviewProgress } from './useReviewProgress';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let originalFetch: typeof fetch;
let api: ReturnType<typeof useReviewProgress>;
let viewed: Set<string>;
let suppressed: Set<string>;
const restoreMocks: Array<() => void> = [];

function Harness({ id }: { id: string }) {
  const [files, setViewedFiles] = useState(new Set<string>());
  const [suppressedFiles, setSuppressedFiles] = useState(new Set<string>());
  viewed = files;
  suppressed = suppressedFiles;
  api = useReviewProgress({ snapshotId: id, contextKey: 'review', enabled: true, setViewedFiles, setSuppressedFiles });
  return null;
}

async function render(id: string) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => { root!.render(<Harness id={id} />); });
}

const payload = (viewedFiles: string[] = []) => ({
  available: true, key: 'scope', fingerprints: { 'a.ts': 'a', 'b.ts': 'b' }, viewedFiles, suppressedFiles: [],
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const restore of restoreMocks.splice(0)) restore();
});

describe.if(hasDom)('durable review progress binding', () => {
  test('a late restoration cannot undo a click made while loading, and flush includes its save', async () => {
    originalFetch = globalThis.fetch;
    let resolveLoad!: (response: Response) => void;
    const requests: any[] = [];
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'POST') {
        requests.push(JSON.parse(String(options.body)));
        return Response.json({ ok: true });
      }
      return new Promise<Response>(resolve => { resolveLoad = resolve; });
    }) as typeof fetch;
    await render('one');
    act(() => api.persistViewed(['a.ts'], false));
    await act(async () => {
      resolveLoad(Response.json(payload(['a.ts', 'b.ts'])));
      await api.flush();
    });
    expect([...viewed]).toEqual(['b.ts']);
    expect(requests).toEqual([{ key: 'scope', changes: [{ path: 'a.ts', fingerprint: 'a', viewed: false }] }]);
  });

  test('old-snapshot loads cannot restore marks into the new review', async () => {
    originalFetch = globalThis.fetch;
    const loads = new Map<string, (response: Response) => void>();
    globalThis.fetch = (async (url: string) => new Promise<Response>(resolve => loads.set(url, resolve))) as typeof fetch;
    await render('one');
    await render('two');
    await act(async () => { loads.get('/api/review-progress?snapshot=two')!(Response.json(payload(['b.ts']))); });
    await act(async () => { loads.get('/api/review-progress?snapshot=one')!(Response.json(payload(['a.ts']))); });
    expect([...viewed]).toEqual(['b.ts']);
  });

  test('rapid viewed/unviewed updates are written in order', async () => {
    originalFetch = globalThis.fetch;
    let finishFirst!: (response: Response) => void;
    const written: boolean[] = [];
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      if (options?.method !== 'POST') return Response.json(payload());
      written.push(JSON.parse(String(options.body)).changes[0].viewed);
      if (written.length === 1) return new Promise<Response>(resolve => { finishFirst = resolve; });
      return Response.json({ ok: true });
    }) as typeof fetch;
    await render('one');
    await act(async () => { api.persistViewed(['a.ts'], true); api.persistViewed(['a.ts'], false); });
    expect(written).toEqual([true]);
    await act(async () => { finishFirst(Response.json({ ok: true })); await api.flush(); });
    expect(written).toEqual([true, false]);
  });

  test('failed/unsupported restoration keeps current marks; a failed load retries on the same snapshot', async () => {
    originalFetch = globalThis.fetch;
    let outcome: 'ready' | 'error' | 'unsupported' = 'ready';
    const writes: boolean[] = [];
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'POST') {
        writes.push(JSON.parse(String(options.body)).changes[0].viewed);
        return Response.json({ ok: true });
      }
      if (outcome === 'error') return new Response('', { status: 500 });
      if (outcome === 'unsupported') return Response.json({ available: false });
      return Response.json(payload(['a.ts']));
    }) as typeof fetch;
    await render('one');
    outcome = 'unsupported';
    await render('two');
    expect(api.status).toBe('unsupported');
    expect([...viewed]).toEqual(['a.ts']);
    outcome = 'error';
    await render('three');
    expect(api.status).toBe('error');
    expect([...viewed]).toEqual(['a.ts']);
    await act(async () => { api.persistViewed(['a.ts'], false); });
    expect(api.status).toBe('error');
    outcome = 'ready';
    await act(async () => { await api.flush(); });
    expect(api.status).toBe('ready');
    expect([...viewed]).toEqual([]);
    expect(writes).toEqual([false]);
  });

  test('a failed write is retried before leaving, without reversing later edits', async () => {
    originalFetch = globalThis.fetch;
    const writes: boolean[] = [];
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      if (options?.method !== 'POST') return Response.json(payload());
      writes.push(JSON.parse(String(options.body)).changes[0].viewed);
      return new Response('', { status: writes.length === 1 ? 500 : 200 });
    }) as typeof fetch;
    await render('one');
    await act(async () => { api.persistViewed(['a.ts'], false); });
    await act(async () => { await api.flush(); });
    expect(writes).toEqual([false, false]);
  });

  test('an explicit uncheck remains suppressed after an in-session content refresh', async () => {
    originalFetch = globalThis.fetch;
    let first = true;
    globalThis.fetch = (async () => {
      const data = { ...payload(), suppressedFiles: first ? ['a.ts'] : [] };
      first = false;
      return Response.json(data);
    }) as typeof fetch;
    await render('one');
    expect([...suppressed]).toEqual(['a.ts']);
    await render('changed-content');
    expect([...suppressed]).toEqual(['a.ts']);
  });

  for (const stalledAt of ['headers', 'body'] as const) {
    test(`a load stalled at ${stalledAt} times out, preserves marks and can recover`, async () => {
      originalFetch = globalThis.fetch;
      const controllers: AbortController[] = [];
      const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      });
      restoreMocks.push(() => timeout.mockRestore());
      let stalled = false;
      globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
        if (!stalled) return Response.json(payload(['a.ts']));
        const pending = new Promise<Response>((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
        });
        if (stalledAt === 'headers') return pending;
        return { ok: true, status: 200, json: () => pending } as unknown as Response;
      }) as typeof fetch;
      await render('one');
      stalled = true;
      await render('two');
      await act(async () => {
        const flushed = api.flush();
        controllers.at(-1)!.abort(new DOMException('Timed out', 'TimeoutError'));
        await flushed;
      });
      expect(api.status).toBe('error');
      expect([...viewed]).toEqual(['a.ts']);
      stalled = false;
      await act(async () => { await api.flush(); });
      expect(api.status).toBe('ready');
    });
  }

  test('flush has one deadline for a stalled write queue and keeps failed edits retryable', async () => {
    originalFetch = globalThis.fetch;
    const realSetTimeout = globalThis.setTimeout;
    let expireFlush: (() => void) | undefined;
    // Fire only the flush budget manually; React keeps its normal timers.
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 5000) {
        expireFlush = callback;
        return realSetTimeout(() => {}, 60_000);
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    restoreMocks.push(() => timer.mockRestore());
    let abortRequest: (() => void) | undefined;
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      abortRequest = () => controller.abort(new DOMException('Timed out', 'TimeoutError'));
      return controller.signal;
    });
    restoreMocks.push(() => timeout.mockRestore());
    let stalled = true;
    const writes: boolean[] = [];
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      if (options?.method !== 'POST') return Response.json(payload());
      writes.push(JSON.parse(String(options.body)).changes[0].viewed);
      if (!stalled) return Response.json({ ok: true });
      return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      });
    }) as typeof fetch;
    await render('one');
    await act(async () => { api.persistViewed(['a.ts'], true); api.persistViewed(['a.ts'], false); });
    await act(async () => {
      const flushed = api.flush();
      expireFlush!();
      await flushed;
    });
    // The review action has been released even though the first POST is pending.
    expect(writes).toEqual([true]);
    stalled = false;
    await act(async () => { abortRequest!(); await api.flush(); });
    expect(writes).toEqual([true, false]);
  });
});
