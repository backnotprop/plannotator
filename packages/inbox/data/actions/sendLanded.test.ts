import { afterEach, expect, test } from 'bun:test';
import { replyLanded } from './sendLanded';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a lost answer is looked for once, within a bound: a read that never answers says unknown and frees the box', async () => {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
  const started = Date.now();
  expect(await replyLanded('msg_T', 'k1', 60)).toBe('unknown');
  expect(Date.now() - started).toBeLessThan(2000);
});
