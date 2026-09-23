/**
 * Client image cache (#1598). Regressions guarded:
 *  - memory: 64 sides at the 10 MB cap would hold ~640 MB, so bytes are capped;
 *  - a late response for an older snapshot must not wipe the current one;
 *  - eviction must not revoke a URL a mounted <img> is still using.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  MAX_CACHED_IMAGE_BYTES,
  fetchReviewImage,
  peekReviewImage,
  resetReviewImageCache,
  retainReviewImageUrl,
  reviewImageCacheStats,
} from './reviewImage';

const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let revoked: string[] = [];
let urlCounter = 0;

function serveBytes(size: number, gate?: Promise<void>) {
  globalThis.fetch = (async () => {
    await gate;
    return new Response(new Uint8Array(size), { headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  revoked = [];
  urlCounter = 0;
  URL.createObjectURL = () => `blob:test/${++urlCounter}`;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  resetReviewImageCache();
  revoked = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

const signal = () => new AbortController().signal;

describe('review image cache', () => {
  test('total cached bytes stay under the byte cap', async () => {
    const size = 10 * 1024 * 1024;
    serveBytes(size);
    for (let i = 0; i < 20; i++) {
      const result = await fetchReviewImage('snap', `img-${i}.png`, 'new', signal());
      expect(result.ok).toBe(true);
    }
    const stats = reviewImageCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(MAX_CACHED_IMAGE_BYTES);
    expect(stats.entries).toBe(Math.floor(MAX_CACHED_IMAGE_BYTES / size));
    // The oldest were evicted, the newest survive.
    expect(peekReviewImage('snap', 'img-0.png', 'new')).toBeUndefined();
    expect(peekReviewImage('snap', 'img-19.png', 'new')).toBeDefined();
  });

  test("a late response for an older snapshot neither caches nor wipes the current snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serveBytes(8, gate);
    const late = fetchReviewImage('old-snap', 'a.png', 'new', signal());
    serveBytes(8);
    await fetchReviewImage('new-snap', 'b.png', 'new', signal());
    serveBytes(8);
    release();
    await expect(late).rejects.toThrow();
    expect(reviewImageCacheStats().snapshot).toBe('new-snap');
    expect(peekReviewImage('new-snap', 'b.png', 'new')).toBeDefined();
  });

  test('an evicted URL a mounted image still uses is revoked only on release', async () => {
    serveBytes(64 * 1024 * 1024);
    const first = await fetchReviewImage('snap', 'a.png', 'new', signal());
    if (!first.ok) throw new Error('expected ok');
    const release = retainReviewImageUrl(first.image.url);
    // Two more 64 MB sides push the first out of the 128 MB cache.
    await fetchReviewImage('snap', 'b.png', 'new', signal());
    await fetchReviewImage('snap', 'c.png', 'new', signal());
    expect(peekReviewImage('snap', 'a.png', 'new')).toBeUndefined();
    expect(revoked).not.toContain(first.image.url);
    release();
    expect(revoked).toContain(first.image.url);
  });
});
