import { afterEach, expect, test } from 'bun:test';
import { loadSemDiffAdvert, resetSemDiffAdvertForTests, semDiffAdvertNow } from './semDiffAdvert';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetSemDiffAdvertForTests();
});

test('an advert that never answers lets readers draw without semantic diffs, does not hold the next reader, and is asked again after a while', async () => {
  resetSemDiffAdvertForTests(80);
  let asked = 0;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    asked++;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }) as typeof fetch;
  expect(await loadSemDiffAdvert(40)).toBeNull();
  expect(semDiffAdvertNow()).toBeNull();
  const order: string[] = [];
  const again = loadSemDiffAdvert(40).then((value) => order.push(`answer ${String(value)}`));
  const limit = new Promise<void>((resolve) => setTimeout(resolve, 40)).then(() => order.push('the limit'));
  await Promise.all([again, limit]);
  expect([asked, order]).toEqual([1, ['answer null', 'the limit']]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(semDiffAdvertNow()).toBeUndefined();
  globalThis.fetch = (async () => new Response(JSON.stringify({ advert: { runtime: 'x' } }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  expect(await loadSemDiffAdvert(40)).toEqual({ runtime: 'x' });
  expect(asked).toBe(1);
});
