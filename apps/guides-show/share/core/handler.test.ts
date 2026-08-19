import { describe, expect, test } from 'bun:test';
import { compress, decompress } from '@plannotator/core/compress';
import { decrypt, encrypt } from '@plannotator/core/crypto';
import { FIXTURE_V1_LOCAL, FIXTURE_V1_PR } from '@plannotator/core/guide-format-fixtures';
import {
  GUIDE_HOSTED_META_NAME,
  GUIDE_PAYLOAD_META_NAME,
  GUIDE_SNAPSHOT_SCRIPT_ID,
  parseGuideSnapshot,
} from '@plannotator/core/guide-format';
import { MemoryGuideStore } from '../stores/memory';
import { MAX_SHARED_GUIDE_BYTES, handleGuideShareRequest, isGuideShareRoute, sha256Hex, type GuideShareContext } from './handler';

const ORIGIN = 'https://guides.show';
const MANIFEST = { js: 'viewer.bundled.js', css: 'viewer.bundled.css', jsIntegrity: 'sha384-bundledjs', cssIntegrity: 'sha384-bundledcss' };

function context(overrides: Partial<GuideShareContext> = {}): GuideShareContext & { store: MemoryGuideStore } {
  const store = new MemoryGuideStore();
  return { store, viewerManifest: MANIFEST, ...overrides } as GuideShareContext & { store: MemoryGuideStore };
}

const call = (ctx: GuideShareContext, path: string, init?: RequestInit) => handleGuideShareRequest(new Request(`${ORIGIN}${path}`, init), ctx);

const post = (ctx: GuideShareContext, body: unknown, headers: Record<string, string> = {}) =>
  call(ctx, '/api/g', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });

interface Created {
  id: string;
  url: string;
  deleteToken: string;
  expiresAt?: string;
}

async function createPlain(ctx: GuideShareContext, extra: Record<string, unknown> = {}): Promise<Created> {
  const res = await post(ctx, { mode: 'plain', data: JSON.stringify(FIXTURE_V1_LOCAL), ...extra });
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

async function createEncrypted(ctx: GuideShareContext, extra: Record<string, unknown> = {}): Promise<Created & { key: string }> {
  const { ciphertext, key } = await encrypt(await compress(FIXTURE_V1_PR));
  const res = await post(ctx, { mode: 'encrypted', data: ciphertext, ...extra });
  expect(res.status).toBe(201);
  return { ...((await res.json()) as Created), key };
}

describe('share handler: create', () => {
  test('plain: 201 with a 22-char id, the hosted url on the request origin, a one-time delete token; body is served back as JSON', async () => {
    const ctx = context();
    const created = await createPlain(ctx);
    expect(created.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.url).toBe(`${ORIGIN}/g/${created.id}`);
    expect(created.deleteToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.expiresAt).toBeUndefined();

    const body = await call(ctx, `/api/g/${created.id}`);
    expect(body.status).toBe(200);
    expect(body.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(body.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(body.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(parseGuideSnapshot(await body.json()).ok).toBe(true);

    // The token is stored hashed, never in the clear.
    const stored = await ctx.store.get(created.id);
    expect(stored?.meta.deleteTokenHash).toBe(await sha256Hex(created.deleteToken));
    expect(stored?.meta.bytes).toBe(new TextEncoder().encode(JSON.stringify(FIXTURE_V1_LOCAL)).byteLength);
  });

  test('encrypted: the body round-trips as opaque text and decrypts back to the snapshot with the uploader-held key', async () => {
    const ctx = context();
    const created = await createEncrypted(ctx);
    const body = await call(ctx, `/api/g/${created.id}`);
    expect(body.status).toBe(200);
    expect(body.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    const snapshot = parseGuideSnapshot(await decompress(await decrypt(await body.text(), created.key)));
    expect(snapshot.ok && snapshot.value.guide.title).toBe(FIXTURE_V1_PR.guide.title);
  });

  test('rejects malformed requests with 400 and a reason', async () => {
    const ctx = context();
    expect((await call(ctx, '/api/g', { method: 'POST', body: '{nope' })).status).toBe(400);
    expect((await post(ctx, { mode: 'secret', data: 'abc' })).status).toBe(400);
    expect((await post(ctx, { mode: 'encrypted' })).status).toBe(400);
    expect((await post(ctx, { mode: 'encrypted', data: '' })).status).toBe(400);
    expect((await post(ctx, { mode: 'encrypted', data: 'not base64url!' })).status).toBe(400);
    expect((await post(ctx, { mode: 'encrypted', data: 'abc', ttlSeconds: -5 })).status).toBe(400);
    expect((await post(ctx, { mode: 'encrypted', data: 'abc', ttlSeconds: 'soon' })).status).toBe(400);
    expect((await post(ctx, { mode: 'encrypted', data: 'abc', viewer: { js: '/etc/passwd', css: 'x.css' } })).status).toBe(400);
    expect((await post(ctx, { mode: 'encrypted', data: 'abc', viewer: { js: 'https://evil.example/v.js', css: 'x.css' } })).status).toBe(400);
    expect((await post(ctx, { mode: 'encrypted', data: 'abc', viewer: { js: 'v.js', css: 'v.css', jsIntegrity: 'md5-nope' } })).status).toBe(400);
    expect(ctx.store.size).toBe(0);
  });

  test('plain data that is not a valid snapshot is rejected with the parser path and message', async () => {
    const ctx = context();
    const broken = { ...FIXTURE_V1_LOCAL, guide: { ...FIXTURE_V1_LOCAL.guide, sections: 'nope' } };
    const res = await post(ctx, { mode: 'plain', data: JSON.stringify(broken) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; path: string; message: string };
    expect(body.error).toBe('invalid snapshot');
    expect(body.path).toBe('$.guide.sections');
    expect(body.message.length).toBeGreaterThan(0);

    const notJson = await post(ctx, { mode: 'plain', data: '{' });
    expect(((await notJson.json()) as { path: string }).path).toBe('$');
    expect(ctx.store.size).toBe(0);
  });

  test('bodies over MAX_SHARED_GUIDE_BYTES are refused with 413 and the cap', async () => {
    const ctx = context();
    const res = await post(ctx, { mode: 'encrypted', data: 'a'.repeat(MAX_SHARED_GUIDE_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too large', maxBytes: MAX_SHARED_GUIDE_BYTES });
    // A declared Content-Length far over the cap is refused before the body is read.
    const early = await call(ctx, '/api/g', { method: 'POST', body: '{}', headers: { 'Content-Length': String(MAX_SHARED_GUIDE_BYTES * 3) } });
    expect(early.status).toBe(413);
    expect(ctx.store.size).toBe(0);
  });

  test('ttlSeconds sets expiresAt; an expired guide is gone from every route', async () => {
    let now = Date.parse('2026-08-15T12:00:00.000Z');
    const store = new MemoryGuideStore(() => now);
    const ctx: GuideShareContext = { store, viewerManifest: MANIFEST, now: () => new Date(now) };
    const created = await createPlain(ctx, { ttlSeconds: 3600 });
    expect(created.expiresAt).toBe('2026-08-15T13:00:00.000Z');
    expect((await call(ctx, `/g/${created.id}`)).status).toBe(200);
    now += 3600 * 1000 + 1;
    expect((await call(ctx, `/g/${created.id}`)).status).toBe(404);
    expect((await call(ctx, `/api/g/${created.id}`)).status).toBe(404);
    expect((await call(ctx, `/api/g/${created.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${created.deleteToken}` } })).status).toBe(404);
  });
});

describe('share handler: pages', () => {
  test('plain page is the pinned viewer over the embedded snapshot with og:title and the hosted meta, and no payload meta', async () => {
    const ctx = context();
    const created = await createPlain(ctx);
    const res = await call(ctx, `/g/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const html = await res.text();
    expect(html).toContain(`<meta property="og:title" content="${FIXTURE_V1_LOCAL.guide.title}">`);
    // The id of a plain guide is the whole capability: no outbound click may leak the page URL as Referer.
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    // og:site_name is the serving host, so a self-host does not unfurl as guides.show.
    expect(html).toContain(`<meta property="og:site_name" content="${new URL(ORIGIN).host}">`);
    expect(html).toContain(`<meta name="${GUIDE_HOSTED_META_NAME}" content="${created.url}">`);
    expect(html).toContain(`<link rel="canonical" href="${created.url}">`);
    expect(html).not.toContain(GUIDE_PAYLOAD_META_NAME);
    expect(html).toContain(`id="${GUIDE_SNAPSHOT_SCRIPT_ID}"`);
    // Viewer assets come from THIS host's /v1/, using the bundled manifest when the upload carried no pin.
    expect(html).toContain(`src="${ORIGIN}/v1/${MANIFEST.js}" integrity="${MANIFEST.jsIntegrity}"`);
    expect(html).toContain(`href="${ORIGIN}/v1/${MANIFEST.css}"`);
  });

  test('encrypted page is the shell: payload meta pointing at /api/g/<id>, hosted meta, no title, intent, or snapshot', async () => {
    const ctx = context();
    const created = await createEncrypted(ctx);
    const html = await (await call(ctx, `/g/${created.id}`)).text();
    expect(html).toContain(`<meta name="${GUIDE_PAYLOAD_META_NAME}" content="/api/g/${created.id}">`);
    expect(html).toContain(`<meta name="${GUIDE_HOSTED_META_NAME}" content="${created.url}">`);
    expect(html).not.toContain(FIXTURE_V1_PR.guide.title);
    expect(html).not.toContain(FIXTURE_V1_PR.guide.intent);
    expect(html).not.toContain(`id="${GUIDE_SNAPSHOT_SCRIPT_ID}"`);
  });

  test('an uploaded viewer pin wins over the bundled manifest, but the base is always this host', async () => {
    const ctx = context();
    const pin = { js: 'viewer.pinned.js', css: 'viewer.pinned.css', jsIntegrity: 'sha384-pinnedjs', langs: { typescript: 'chunks/typescript.abc.js' } };
    const created = await createPlain(ctx, { viewer: pin });
    const html = await (await call(ctx, `/g/${created.id}`)).text();
    expect(html).toContain(`src="${ORIGIN}/v1/viewer.pinned.js" integrity="sha384-pinnedjs"`);
    expect(html).toContain(`href="${ORIGIN}/v1/chunks/typescript.abc.js"`);
    expect(html).not.toContain(MANIFEST.js);
    // A different host origin renders against ITS /v1/, not the uploader's.
    const elsewhere = await handleGuideShareRequest(new Request(`http://localhost:8788/g/${created.id}`), ctx);
    const local = await elsewhere.text();
    expect(local).toContain('src="http://localhost:8788/v1/viewer.pinned.js"');
    expect(local).toContain(`content="http://localhost:8788/g/${created.id}"`);
  });

  test('unknown, malformed, and removed ids get the styled 404 page, named after the serving host', async () => {
    const ctx = context();
    for (const path of ['/g/doesnotexist0000000000', '/g/short', '/g/', '/g']) {
      const res = await call(ctx, path);
      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      const html = await res.text();
      expect(html).toContain('class="pgr-fallback"');
      expect(html).toContain('<meta name="robots" content="noindex">');
    }
    // A self-host's failure page is not branded guides.show.
    const selfHosted = await handleGuideShareRequest(new Request('https://guides.example.com:8443/g/doesnotexist0000000000'), ctx);
    const selfHtml = await selfHosted.text();
    expect(selfHtml).toContain('<a href="/">guides.example.com:8443</a>');
    expect(selfHtml).not.toContain('guides.show');
    expect((await call(ctx, '/api/g/doesnotexist0000000000')).status).toBe(404);
    expect(await (await call(ctx, '/api/g/doesnotexist0000000000')).json()).toEqual({ error: 'not found' });
  });
});

describe('share handler: delete', () => {
  test('bearer token semantics: missing 401, wrong 401, right 204, then 404 everywhere', async () => {
    const ctx = context();
    const created = await createPlain(ctx);
    const del = (headers: Record<string, string> = {}) => call(ctx, `/api/g/${created.id}`, { method: 'DELETE', headers });
    expect((await del()).status).toBe(401);
    expect((await del({ Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await del({ Authorization: `Basic ${created.deleteToken}` })).status).toBe(401);
    expect((await call(ctx, `/g/${created.id}`)).status).toBe(200);
    const ok = await del({ Authorization: `Bearer ${created.deleteToken}` });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect((await call(ctx, `/g/${created.id}`)).status).toBe(404);
    expect((await call(ctx, `/api/g/${created.id}`)).status).toBe(404);
    expect((await del({ Authorization: `Bearer ${created.deleteToken}` })).status).toBe(404);
  });

  test('a token for one guide does not open another', async () => {
    const ctx = context();
    const a = await createPlain(ctx);
    const b = await createEncrypted(ctx);
    const res = await call(ctx, `/api/g/${b.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${a.deleteToken}` } });
    expect(res.status).toBe(401);
    expect((await call(ctx, `/api/g/${b.id}`)).status).toBe(200);
  });
});

describe('share handler: routing and CORS', () => {
  test('OPTIONS preflight on /api/g* allows the API verbs and headers', async () => {
    const ctx = context();
    for (const path of ['/api/g', '/api/g/whatever']) {
      const res = await call(ctx, path, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, GET, DELETE, OPTIONS');
      expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
    }
  });

  test('wrong verbs are 405 with Allow; unknown api paths are 404 JSON', async () => {
    const ctx = context();
    expect((await call(ctx, '/api/g')).status).toBe(405);
    expect((await call(ctx, '/api/g/abc', { method: 'PUT' })).status).toBe(405);
    expect((await call(ctx, '/g/abc', { method: 'POST' })).status).toBe(405);
    expect((await call(ctx, '/api/g/a/b')).status).toBe(404);
  });

  test('isGuideShareRoute claims exactly the share paths', () => {
    expect(isGuideShareRoute('/g')).toBe(true);
    expect(isGuideShareRoute('/g/abc')).toBe(true);
    expect(isGuideShareRoute('/api/g')).toBe(true);
    expect(isGuideShareRoute('/api/g/abc')).toBe(true);
    expect(isGuideShareRoute('/gx')).toBe(false);
    expect(isGuideShareRoute('/api/guides')).toBe(false);
    expect(isGuideShareRoute('/v1/viewer.js')).toBe(false);
    expect(isGuideShareRoute('/')).toBe(false);
  });

  test('a store failure is a 500, never a cached response; the store message goes to the log, not the client', async () => {
    const logged: unknown[] = [];
    const boom = new Error("EACCES: permission denied, open '/srv/guides-data/x.meta.json'");
    const ctx = context({
      store: { put: async () => { throw boom; }, get: async () => { throw boom; }, delete: async () => {} },
      logError: (_message, error) => { logged.push(error); },
    });
    const api = await call(ctx, '/api/g/doesnotexist0000000000');
    expect(api.status).toBe(500);
    expect(api.headers.get('Cache-Control')).toBe('no-store');
    expect(await api.text()).not.toContain('/srv/guides-data');
    const page = await call(ctx, '/g/doesnotexist0000000000');
    expect(page.status).toBe(500);
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(await page.text()).not.toContain('/srv/guides-data');
    expect(logged).toEqual([boom, boom]);
  });
});
