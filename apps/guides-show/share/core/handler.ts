/**
 * Shared-guide request handling (contract: adr/implementation/guide-share-hosting.md §1, §2, §4).
 *
 * Pure `(Request, context) → Response`: no bindings, no runtime globals beyond
 * WebCrypto and `URL`, so the Cloudflare Worker runs it over an R2 store and
 * the tests over an in-memory one. Routes:
 *
 *   POST    /api/g          create  → 201 { id, url, deleteToken, expiresAt? }
 *   GET     /api/g/<id>     body    → ciphertext (text/plain) or snapshot JSON
 *   DELETE  /api/g/<id>     delete  → 204 (Authorization: Bearer <deleteToken>)
 *   OPTIONS /api/g*         CORS preflight
 *   GET     /g/<id>         page    → the pinned viewer over the guide (plain) or
 *                                     the encrypted shell that fetches /api/g/<id>
 *
 * The request origin is the host: pages pin `<origin>/v1/` as the viewer base
 * and `<origin>/g/<id>` as their canonical URL. Uploaders never send a base URL.
 */

import {
  FALLBACK_STYLE,
  createGuideHtml,
  createGuideShellHtml,
  escapeHtmlText,
  parseGuideSnapshotJson,
  type GuideSnapshotV1,
  type GuideViewerAssets,
} from '@plannotator/core/guide-format';
import { isStoredGuideExpired, type GuideStore, type SharedGuideMode, type StoredGuideMeta, type StoredGuideViewerPin } from './storage';

/** Cap on the stored body (the ciphertext or the snapshot JSON). The downloadable file has no cap; the host must. */
export const MAX_SHARED_GUIDE_BYTES = 25 * 1024 * 1024;

/** Longest `ttlSeconds` accepted at create (10 years). Absent = never expires; this only keeps the arithmetic sane. */
export const MAX_SHARED_GUIDE_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

export interface GuideShareContext {
  readonly store: GuideStore;
  /** The host's own bundled viewer build, used when an upload carries no pin. */
  readonly viewerManifest: Omit<GuideViewerAssets, 'baseUrl'>;
  /** Where store failures are reported (default `console.error`); the response never carries the store's own message. */
  readonly logError?: (message: string, error: unknown) => void;
  /** Injectable clock for expiry tests. */
  readonly now?: () => Date;
}

/** Path prefixes this handler owns; hosts route these here and keep everything else (viewer assets, landing) to themselves. */
export function isGuideShareRoute(pathname: string): boolean {
  return pathname === '/g' || pathname.startsWith('/g/') || pathname === '/api/g' || pathname.startsWith('/api/g/');
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * The CORS headers every `/api/g*` response carries, exported so a host can
 * answer for the handler with the same contract when it refuses a request
 * before dispatch (the Worker's rate-limited create).
 */
export const GUIDE_SHARE_CORS_HEADERS = CORS_HEADERS;

/** Guide ids are 16 random bytes as unpadded base64url: exactly 22 URL-safe characters. Anything else is unknown, not malformed. */
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Viewer pin paths are relative to the host's `/v1/`: plain nested filenames only, never absolute, never traversing. */
const VIEWER_PATH_PATTERN = /^[A-Za-z0-9._\-\/]+$/;
const INTEGRITY_PATTERN = /^sha(256|384|512)-[A-Za-z0-9+\/]+={0,2}$/;
const PAGE_CACHE_CONTROL = 'public, max-age=300';

export async function handleGuideShareRequest(req: Request, ctx: GuideShareContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (path === '/api/g' || path.startsWith('/api/g/')) return await handleApi(req, url, ctx);
    const page = path.match(/^\/g\/([^/]+)$/);
    if (page) return await handlePage(req, url, page[1], ctx);
    return notFoundPage(url);
  } catch (error) {
    // A store that throws (R2 outage, disk full) is a host failure, never a
    // reviewer-facing outcome; say so plainly and do not cache it. The store's
    // own message (paths, bucket errors) stays in the host's log.
    (ctx.logError ?? defaultLogError)(`guides.show: ${req.method} ${path} failed`, error);
    if (path.startsWith('/api/')) return json({ error: 'internal error' }, 500, { ...CORS_HEADERS, 'Cache-Control': 'no-store' });
    return htmlPage(errorPage(url, 'Something went wrong', 'This guide could not be served right now. Try again in a moment.'), 500, { 'Cache-Control': 'no-store' });
  }
}

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------
// /api/g*
// ---------------------------------------------------------------------------

async function handleApi(req: Request, url: URL, ctx: GuideShareContext): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const path = url.pathname;
  if (path === '/api/g') {
    if (req.method === 'POST') return handleCreate(req, url, ctx);
    return json({ error: 'method not allowed' }, 405, { ...CORS_HEADERS, Allow: 'POST, OPTIONS' });
  }
  const match = path.match(/^\/api\/g\/([^/]+)$/);
  if (!match) return json({ error: 'not found' }, 404, CORS_HEADERS);
  const id = match[1];
  if (req.method === 'GET' || req.method === 'HEAD') return handleBody(req, id, ctx);
  if (req.method === 'DELETE') return handleDelete(req, id, ctx);
  return json({ error: 'method not allowed' }, 405, { ...CORS_HEADERS, Allow: 'GET, HEAD, DELETE, OPTIONS' });
}

interface CreateBody {
  mode?: unknown;
  data?: unknown;
  viewer?: unknown;
  ttlSeconds?: unknown;
}

async function handleCreate(req: Request, url: URL, ctx: GuideShareContext): Promise<Response> {
  // Refuse to read a body that cannot possibly fit before buffering it. The
  // JSON envelope around `data` is small, so twice the cap is a generous bound.
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_SHARED_GUIDE_BYTES * 2) {
    return json({ error: 'too large', maxBytes: MAX_SHARED_GUIDE_BYTES }, 413, CORS_HEADERS);
  }
  let body: CreateBody;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bad('body must be a JSON object');
    body = parsed as CreateBody;
  } catch {
    return bad('body must be valid JSON');
  }
  if (body.mode !== 'encrypted' && body.mode !== 'plain') return bad('mode must be "encrypted" or "plain"');
  const mode: SharedGuideMode = body.mode;
  if (typeof body.data !== 'string' || body.data.length === 0) return bad('data must be a non-empty string');
  const data = body.data;
  const bytes = new TextEncoder().encode(data).byteLength;
  if (bytes > MAX_SHARED_GUIDE_BYTES) return json({ error: 'too large', maxBytes: MAX_SHARED_GUIDE_BYTES }, 413, CORS_HEADERS);

  const ttl = parseTtl(body.ttlSeconds);
  if (!ttl.ok) return bad(ttl.error);
  const viewer = parseViewerPin(body.viewer);
  if (!viewer.ok) return bad(viewer.error);

  if (mode === 'plain') {
    const parsed = parseGuideSnapshotJson(data);
    if (!parsed.ok) return json({ error: 'invalid snapshot', path: parsed.error.path, message: parsed.error.message }, 400, CORS_HEADERS);
  } else if (!BASE64URL_PATTERN.test(data)) {
    return bad('encrypted data must be base64url');
  }

  const now = (ctx.now ?? (() => new Date()))();
  const id = randomBase64url(16);
  const deleteToken = randomBase64url(16);
  const expiresAt = ttl.value === undefined ? undefined : new Date(now.getTime() + ttl.value * 1000).toISOString();
  const meta: StoredGuideMeta = {
    mode,
    createdAt: now.toISOString(),
    ...(expiresAt !== undefined && { expiresAt }),
    deleteTokenHash: await sha256Hex(deleteToken),
    ...(viewer.value !== undefined && { viewer: viewer.value }),
    bytes,
  };
  await ctx.store.put(id, data, meta);
  return json(
    { id, url: hostedUrl(url, id), deleteToken, ...(expiresAt !== undefined && { expiresAt }) },
    201,
    { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
  );
}

async function handleBody(req: Request, id: string, ctx: GuideShareContext): Promise<Response> {
  const found = await lookup(id, ctx);
  if (!found) return json({ error: 'not found' }, 404, { ...CORS_HEADERS, 'Cache-Control': 'no-store' });
  const headers = {
    ...CORS_HEADERS,
    'Content-Type': found.meta.mode === 'plain' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': PAGE_CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(found.meta.bytes),
  };
  return new Response(req.method === 'HEAD' ? null : found.body, { status: 200, headers });
}

async function handleDelete(req: Request, id: string, ctx: GuideShareContext): Promise<Response> {
  const token = bearerToken(req);
  const noStore = { ...CORS_HEADERS, 'Cache-Control': 'no-store' };
  if (!token) return json({ error: 'missing delete token' }, 401, noStore);
  const found = await lookup(id, ctx);
  if (!found) return json({ error: 'not found' }, 404, noStore);
  if (!constantTimeEqual(await sha256Hex(token), found.meta.deleteTokenHash)) return json({ error: 'invalid delete token' }, 401, noStore);
  await ctx.store.delete(id);
  return new Response(null, { status: 204, headers: noStore });
}

// ---------------------------------------------------------------------------
// /g/<id>
// ---------------------------------------------------------------------------

async function handlePage(req: Request, url: URL, id: string, ctx: GuideShareContext): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const found = await lookup(id, ctx);
  if (!found) return notFoundPage(url, req.method === 'HEAD');
  const viewer = viewerAssetsFor(url, found.meta.viewer ?? ctx.viewerManifest);
  const hosted = { url: hostedUrl(url, id) };
  let html: string;
  if (found.meta.mode === 'plain') {
    const parsed = parseGuideSnapshotJson(found.body);
    if (!parsed.ok) {
      return htmlPage(errorPage(url, 'Guide unreadable', 'The stored guide is not a valid snapshot.'), 500, { 'Cache-Control': 'no-store' });
    }
    html = renderGuidePage(parsed.value, viewer, hosted);
  } else {
    html = renderShellPage(viewer, hosted, `/api/g/${id}`);
  }
  return htmlPage(req.method === 'HEAD' ? null : html, 200, { 'Cache-Control': PAGE_CACHE_CONTROL });
}

function renderGuidePage(snapshot: GuideSnapshotV1, viewer: GuideViewerAssets, hosted: { url: string }): string {
  return createGuideHtml(snapshot, { viewer, hosted });
}

function renderShellPage(viewer: GuideViewerAssets, hosted: { url: string }, payloadUrl: string): string {
  return createGuideShellHtml({ viewer, hosted, payloadUrl });
}

/** The host serves the viewer from its own origin; `createGuideHtml` refuses anything but https (or http on localhost), which is the deployment invariant, not a request-time choice. */
function viewerAssetsFor(url: URL, pin: Omit<GuideViewerAssets, 'baseUrl'>): GuideViewerAssets {
  return { ...pin, baseUrl: `${url.origin}/v1/` };
}

function hostedUrl(url: URL, id: string): string {
  return `${url.origin}/g/${id}`;
}

async function lookup(id: string, ctx: GuideShareContext): Promise<{ body: string; meta: StoredGuideMeta } | null> {
  if (!ID_PATTERN.test(id)) return null;
  const found = await ctx.store.get(id);
  if (!found) return null;
  // Stores may drop expired guides lazily; the handler never serves one either way.
  if (isStoredGuideExpired(found.meta, (ctx.now ?? (() => new Date()))().getTime())) return null;
  return found;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function parseTtl(input: unknown): Validated<number | undefined> {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 1) return { ok: false, error: 'ttlSeconds must be a positive number of seconds' };
  const seconds = Math.floor(input);
  if (seconds > MAX_SHARED_GUIDE_TTL_SECONDS) return { ok: false, error: `ttlSeconds must be at most ${MAX_SHARED_GUIDE_TTL_SECONDS}` };
  return { ok: true, value: seconds };
}

function isViewerPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && VIEWER_PATH_PATTERN.test(value) && !value.includes('..') && !value.startsWith('/');
}

function parseViewerPin(input: unknown): Validated<StoredGuideViewerPin | undefined> {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  const invalid = { ok: false as const, error: 'viewer must be { js, css, jsIntegrity?, cssIntegrity?, langs? } with paths relative to /v1/' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid;
  const v = input as Record<string, unknown>;
  if (!isViewerPath(v.js) || !isViewerPath(v.css)) return invalid;
  const pin: StoredGuideViewerPin = { js: v.js, css: v.css };
  for (const key of ['jsIntegrity', 'cssIntegrity'] as const) {
    const value = v[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !INTEGRITY_PATTERN.test(value)) return invalid;
    pin[key] = value;
  }
  if (v.langs !== undefined) {
    if (!v.langs || typeof v.langs !== 'object' || Array.isArray(v.langs)) return invalid;
    const langs: Record<string, string> = {};
    for (const [lang, path] of Object.entries(v.langs as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9._+-]{1,64}$/.test(lang) || !isViewerPath(path)) return invalid;
      langs[lang] = path;
    }
    pin.langs = langs;
  }
  return { ok: true, value: pin };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Ids, tokens, hashing (WebCrypto only)
// ---------------------------------------------------------------------------

/** `n` random bytes as unpadded base64url (16 bytes → 22 chars). */
export function randomBase64url(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytesToBase64url(bytes);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

function bad(message: string): Response {
  return json({ error: message }, 400, CORS_HEADERS);
}

function htmlPage(html: string | null, status: number, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    // A plain guide's id is the whole capability; never let a click on the
    // guide's PR link (or any outbound link) hand it to a third party as Referer.
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers },
  });
}

function notFoundPage(url: URL, headOnly = false): Response {
  const html = errorPage(url, 'Guide not found', 'This guide does not exist, has expired, or was removed by whoever shared it.');
  return htmlPage(headOnly ? null : html, 404, { 'Cache-Control': 'public, max-age=60' });
}

/**
 * The failure page names the host it is served from (`url.host`): a self-host
 * is not guides.show. It wears core's `.pgr-fallback` styling so a missing
 * guide reads as part of the same product; the fallback's delayed reveal is
 * overridden because there is no viewer coming to replace this article.
 */
function errorPage(url: URL, title: string, message: string): string {
  const host = escapeHtmlText(url.host);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtmlText(title)} · ${host}</title>
<style>${FALLBACK_STYLE}.pgr-fallback{opacity:1;animation:none}</style>
</head>
<body class="pgr-fallback-body">
<div id="root"><article class="pgr-fallback"><header><h1>${escapeHtmlText(title)}</h1><p class="meta">${escapeHtmlText(message)}</p><p class="meta"><a href="/">${host}</a> hosts portable Plannotator Guided Reviews.</p></header></article></div>
</body>
</html>
`;
}
