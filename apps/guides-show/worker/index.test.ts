import { describe, expect, test } from 'bun:test';
import { GUIDE_VIEWER_MANIFEST } from '@plannotator/core/guide-viewer-manifest';
import { FIXTURE_V1_LOCAL } from '@plannotator/core/guide-format-fixtures';
import { GUIDE_PAYLOAD_META_NAME } from '@plannotator/core/guide-format';
import worker, { viewerAssetHeaders, viewerKeyFromPath, type Env } from './index';

/** Enough of R2Bucket for both bindings: /v1 reads (head/get with body) and the guide store (put/get text/delete). */
class FakeBucket {
  constructor(private objects: Record<string, string> = {}) {}
  async head(key: string) {
    const body = this.objects[key];
    return body === undefined ? null : { key, size: body.length, httpEtag: `"${key}"` };
  }
  async get(key: string) {
    const body = this.objects[key];
    return body === undefined ? null : { key, size: body.length, httpEtag: `"${key}"`, body, text: async () => body };
  }
  async put(key: string, value: string) {
    this.objects[key] = value;
    return { key };
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.objects[key];
  }
  keys(): string[] {
    return Object.keys(this.objects);
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env & { GUIDES: R2Bucket & FakeBucket } {
  return {
    VIEWER: new FakeBucket({ 'v1/viewer.abc.js': 'console.log(1)', 'v1/fonts/inter.woff2': 'F' }) as unknown as R2Bucket,
    GUIDES: new FakeBucket() as unknown as R2Bucket & FakeBucket,
    ASSETS: { fetch: async () => new Response('landing', { status: 200 }) } as unknown as Fetcher,
    ...overrides,
  };
}

/**
 * Stand-in for the Cloudflare rate limiting binding (`[[ratelimits]]`): the
 * first `allow` calls per key succeed, the rest do not. `keys` records every
 * call so a test can assert what the Worker keyed on and what it never asked
 * about at all.
 */
function fakeLimiter(allow: number): RateLimit & { keys: string[] } {
  const seen = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const used = (seen.get(key) ?? 0) + 1;
      seen.set(key, used);
      return { success: used <= allow };
    },
  };
}

const env = makeEnv();
const call = (path: string, init?: RequestInit, e: Env = env) => worker.fetch(new Request(`https://guides.show${path}`, init), e);

describe('guides.show worker', () => {
  test('serves /v1 assets from R2 as immutable, cross-origin-readable, typed', async () => {
    const res = await call('/v1/viewer.abc.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
    expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    // file:// documents send Origin: null — only a wildcard lets them load fonts/grammars/the worker.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    const font = await call('/v1/fonts/inter.woff2');
    expect(font.headers.get('Content-Type')).toBe('font/woff2');
    expect(viewerAssetHeaders('v1/x.bin').get('Content-Type')).toBe('application/octet-stream');
  });

  test('HEAD and OPTIONS work; other methods are refused', async () => {
    expect((await call('/v1/viewer.abc.js', { method: 'HEAD' })).status).toBe(200);
    expect((await call('/v1/viewer.abc.js', { method: 'OPTIONS' })).status).toBe(204);
    expect((await call('/v1/viewer.abc.js', { method: 'POST' })).status).toBe(405);
  });

  test('missing assets are 404 with a short cache, never falling through to the landing page', async () => {
    const res = await call('/v1/viewer.nope.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  test('rejects traversal and malformed keys', async () => {
    expect(viewerKeyFromPath('/v1/../secret')).toBeNull();
    expect(viewerKeyFromPath('/v1//x.js')).toBeNull();
    expect(viewerKeyFromPath('/v1/dir/')).toBeNull();
    expect(viewerKeyFromPath('/v1/ok/name-1.2_3.js')).toBe('v1/ok/name-1.2_3.js');
    // Dot segments are resolved by the URL parser before we see them (so they
    // simply leave /v1); anything percent-encoded or otherwise odd is refused.
    expect((await call('/v1/a%5cb.js')).status).toBe(400);
    expect((await call('/v1/a%20b.js')).status).toBe(400);
  });

  test('unknown /api paths outside the share API answer 404 JSON without touching assets', async () => {
    const res = await call('/api/anything');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('guides.show worker: shared guides', () => {
  const postGuide = (body: unknown, e: Env = env, headers: Record<string, string> = {}) =>
    call('/api/g', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } }, e);

  // Only the wiring is asserted here: the R2 store is bound, the bundled
  // GUIDE_VIEWER_MANIFEST is the fallback pin, and the share routes are
  // dispatched on this origin. Route semantics live in share/core/handler.test.ts.
  test('share routes run over the GUIDES bucket with the bundled manifest as the fallback pin', async () => {
    const e = makeEnv();
    const created = await postGuide({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL) }, e);
    expect(created.status).toBe(201);
    const { id, url, deleteToken } = (await created.json()) as { id: string; url: string; deleteToken: string };
    expect(url).toBe(`https://guides.show/g/${id}`);
    const html = await (await call(`/g/${id}`, undefined, e)).text();
    expect(html).toContain(`src="https://guides.show/v1/${GUIDE_VIEWER_MANIFEST.js}"`);
    expect((await call(`/api/g/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${deleteToken}` } }, e)).status).toBe(204);
    expect(e.GUIDES.keys()).toEqual([]);
    expect((await call(`/g/${id}`, undefined, e)).status).toBe(404);

    // An uploaded pin (the real manifest shape) is accepted and ciphertext survives R2 as text.
    const enc = await postGuide({ mode: 'encrypted', data: 'c2VjcmV0LWNpcGhlcnRleHQ', viewer: GUIDE_VIEWER_MANIFEST }, e);
    expect(enc.status).toBe(201);
    const encId = ((await enc.json()) as { id: string }).id;
    expect(await (await call(`/g/${encId}`, undefined, e)).text()).toContain(`<meta name="${GUIDE_PAYLOAD_META_NAME}" content="/api/g/${encId}">`);
    const body = await call(`/api/g/${encId}`, undefined, e);
    expect(body.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await body.text()).toBe('c2VjcmV0LWNpcGhlcnRleHQ');
  });

  test('creation is rate limited per client IP: 429 with Retry-After once the budget is spent', async () => {
    const limiter = fakeLimiter(2);
    const e = makeEnv({ GUIDE_CREATE_LIMITER: limiter });
    const create = () => postGuide({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL) }, e, { 'CF-Connecting-IP': '203.0.113.7' });
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);
    const refused = await create();
    expect(refused.status).toBe(429);
    // 60 = the `simple.period` wrangler.toml declares for the limiter.
    expect(refused.headers.get('Retry-After')).toBe('60');
    // The uploader is a cross-origin client like any other caller of /api/g.
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBe('*');
    // Keyed by the caller, not globally: a different IP still has its budget.
    expect(limiter.keys).toEqual(['203.0.113.7', '203.0.113.7', '203.0.113.7']);
    expect((await postGuide({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL) }, e, { 'CF-Connecting-IP': '198.51.100.9' })).status).toBe(201);
    // Nothing was stored for the refused create.
    expect(e.GUIDES.keys().filter((k) => !k.endsWith('.meta'))).toHaveLength(3);
  });

  test('only creation is limited, and an unresolvable limit never blocks one', async () => {
    const spent = fakeLimiter(0);
    const e = makeEnv({ GUIDE_CREATE_LIMITER: spent });
    const ip = { 'CF-Connecting-IP': '203.0.113.7' };
    // Seed a guide through an env whose limiter is out of the way.
    const seedEnv = makeEnv();
    const created = await postGuide({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL) }, seedEnv);
    const { id, deleteToken } = (await created.json()) as { id: string; deleteToken: string };
    const readEnv = { ...seedEnv, GUIDE_CREATE_LIMITER: spent } as Env;
    // Reads carry no cost, delete already needs the capability token, preflight
    // is not a write, and the viewer assets are static.
    expect((await call(`/g/${id}`, undefined, readEnv)).status).toBe(200);
    expect((await call(`/api/g/${id}`, { headers: ip }, readEnv)).status).toBe(200);
    expect((await call('/api/g', { method: 'OPTIONS', headers: ip }, readEnv)).status).toBe(204);
    expect((await call('/v1/viewer.abc.js', { headers: ip }, readEnv)).status).toBe(200);
    expect((await call(`/api/g/${id}`, { method: 'DELETE', headers: { ...ip, Authorization: `Bearer ${deleteToken}` } }, readEnv)).status).toBe(204);
    expect(spent.keys).toEqual([]);

    // Nothing in front of the Worker to key on: no header, no limiting.
    expect((await postGuide({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL) }, e)).status).toBe(201);
    // No binding at all (self-host, `wrangler dev`, local stand-in).
    expect((await postGuide({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL) }, makeEnv(), ip)).status).toBe(201);
    // A limiter that throws is a broken brake, not a closed door.
    const broken = makeEnv({ GUIDE_CREATE_LIMITER: { limit: async () => { throw new Error('binding unavailable'); } } });
    expect((await postGuide({ mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL) }, broken, ip)).status).toBe(201);
  });

  test('CORS preflight on /api/g* and 404 pages for unknown or reserved guide paths', async () => {
    const preflight = await call('/api/g', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('POST, GET, DELETE, OPTIONS');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
    expect((await call('/api/g/whatever', { method: 'OPTIONS' })).status).toBe(204);
    for (const path of ['/g', '/g/', '/g/nope']) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toContain('class="pgr-fallback"');
    }
    // The landing page and /v1 are untouched by the share routes.
    expect(await (await call('/')).text()).toBe('landing');
    expect((await call('/v1/viewer.abc.js')).status).toBe(200);
  });
});
