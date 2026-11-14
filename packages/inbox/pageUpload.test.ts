/**
 * The window sends an attached HTML page's frame document (the page plus the 271 KB annotation bridge) gzipped, so
 * an iPad on a slow uplink sends about a quarter of it; where the browser cannot gzip, it sends it as before.
 */
import { afterEach, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { inboxApi } from './api';

const saved = { fetch: globalThis.fetch, CompressionStream: globalThis.CompressionStream };
afterEach(() => {
  globalThis.fetch = saved.fetch;
  globalThis.CompressionStream = saved.CompressionStream;
});

function recordPosts() {
  const posts: { headers: Headers; body: Buffer }[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? Buffer.from(init.body) : Buffer.from(new Uint8Array(init?.body as ArrayBuffer)) });
    return Response.json({ id: 'a'.repeat(32), url: `/api/inbox/pages/${'a'.repeat(32)}` });
  }) as typeof fetch;
  return posts;
}

const html = `<!doctype html><script>${'bridge();'.repeat(20_000)}</script>`;

test('a page goes out gzipped and arrives as the same JSON', async () => {
  const posts = recordPosts();
  await inboxApi.page(html);
  expect(posts[0]!.headers.get('Content-Encoding')).toBe('gzip');
  expect(posts[0]!.body.length).toBeLessThan(html.length / 4);
  expect(JSON.parse(gunzipSync(posts[0]!.body).toString('utf8')).html).toBe(html);
});

test('a browser without CompressionStream sends the page as before', async () => {
  const posts = recordPosts();
  (globalThis as { CompressionStream?: unknown }).CompressionStream = undefined;
  await inboxApi.page(html);
  expect(posts[0]!.headers.get('Content-Encoding')).toBeNull();
  expect(JSON.parse(posts[0]!.body.toString('utf8')).html).toBe(html);
});
