import { afterEach, expect, test } from 'bun:test';
import { loadSemDiffAdvert, resetSemDiffAdvertForTests } from './semDiffAdvert';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetSemDiffAdvertForTests();
});

test('an advert that never answers lets the reader draw without semantic diffs, and is asked again later', async () => {
  let asked = 0;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    asked++;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }) as typeof fetch;
  const settled = await Promise.race([loadSemDiffAdvert(40), new Promise((resolve) => setTimeout(() => resolve('hung'), 1_000))]);
  expect(settled).toBeNull();
  globalThis.fetch = (async () => new Response(JSON.stringify({ advert: { runtime: 'x' } }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  expect(await loadSemDiffAdvert(40)).toEqual({ runtime: 'x' });
  expect(asked).toBe(1);
});
