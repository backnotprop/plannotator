import { afterEach, expect, mock, test } from 'bun:test';
import { loadReviewFileContents } from './loadReviewFileContents';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('concurrent readers share both sides of a renamed file in the same snapshot', async () => {
  const reply = Promise.withResolvers<Response>();
  const request = mock(() => reply.promise);
  globalThis.fetch = request as unknown as typeof fetch;
  const first = new AbortController();
  const second = new AbortController();
  const a = loadReviewFileContents('new.py', 'old.py', 'main', 's1', first.signal);
  const b = loadReviewFileContents('new.py', 'old.py', 'main', 's1', second.signal);
  reply.resolve(Response.json({ oldContent: 'before', newContent: 'after' }));
  const results = await Promise.allSettled([a, b]);
  expect(request).toHaveBeenCalledTimes(1);
  const expected = {
    status: 'fulfilled',
    value: { status: 200, contents: { oldContent: 'before', newContent: 'after' } },
  } as const;
  expect(results).toEqual([expected, expected]);
});

test('canceling one reader keeps the request alive for another', async () => {
  const reply = Promise.withResolvers<Response>();
  const request = mock((_: unknown, options?: RequestInit) => {
    expect(options?.signal?.aborted).toBe(false);
    return reply.promise;
  });
  globalThis.fetch = request as unknown as typeof fetch;
  const first = new AbortController();
  const a = loadReviewFileContents('a.py', undefined, undefined, 's1', first.signal);
  const b = loadReviewFileContents('a.py', undefined, undefined, 's1', new AbortController().signal);
  const canceled = a.catch((error: unknown) => error);
  first.abort();
  expect(await canceled).toHaveProperty('name', 'AbortError');
  expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  reply.resolve(new Response(null, { status: 409 }));
  expect(await b).toEqual({ status: 409, contents: null });
});

test('a new snapshot and a later read each request fresh contents', async () => {
  const request = mock(async () => Response.json({ oldContent: 'before', newContent: 'after' }));
  globalThis.fetch = request as unknown as typeof fetch;
  const { signal } = new AbortController();
  await Promise.all([
    loadReviewFileContents('a.py', undefined, 'main', 's1', signal),
    loadReviewFileContents('a.py', undefined, 'main', 's2', signal),
  ]);
  await loadReviewFileContents('a.py', undefined, 'main', 's1', signal);
  expect(request).toHaveBeenCalledTimes(3);
});

test('canceling the last reader aborts the request and allows retry', async () => {
  let attempts = 0;
  const request = mock((_: unknown, options?: RequestInit) => {
    if (++attempts > 1) return Promise.resolve(new Response(null, { status: 404 }));
    return new Promise<Response>((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    });
  });
  globalThis.fetch = request as unknown as typeof fetch;
  const controller = new AbortController();
  const read = loadReviewFileContents('a.py', undefined, 'main', 's1', controller.signal);
  const canceled = read.catch((error: unknown) => error);
  controller.abort();
  expect(await canceled).toHaveProperty('name', 'AbortError');
  expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(await loadReviewFileContents('a.py', undefined, 'main', 's1', new AbortController().signal)).toEqual({
    status: 404,
    contents: null,
  });
});
