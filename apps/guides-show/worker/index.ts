/**
 * guides.show — Cloudflare Worker.
 *
 * Serves the immutable portable-guide viewer from R2 under /v1/, a static
 * landing page, and shared guides: /g/<id> pages plus the /api/g* create,
 * fetch and delete routes (contract: adr/implementation/guide-share-hosting.md).
 * The share routes are the pure handler in ../share/core/handler.ts over an R2
 * store.
 *
 * Why R2 for /v1 and not Workers Static Assets: assets are a per-deploy
 * snapshot, so a file missing from the next deploy disappears — but every HTML
 * ever exported pins a specific viewer build by URL + integrity, and must keep
 * opening forever (D8). R2 objects are only ever added.
 */
import { GUIDE_VIEWER_MANIFEST } from '@plannotator/core/guide-viewer-manifest';
import { GUIDE_SHARE_CORS_HEADERS, handleGuideShareRequest, isGuideShareRoute } from '../share/core/handler';
import { R2GuideStore } from '../share/stores/r2';

export interface Env {
  VIEWER: R2Bucket;
  /** Shared guides: `g/<id>` bodies + `g/<id>.meta` records (see share/stores/r2.ts). */
  GUIDES: R2Bucket;
  ASSETS: Fetcher;
  /**
   * Cloudflare's native rate limiting binding, declared in `wrangler.toml` as
   * `[[ratelimits]] name = "GUIDE_CREATE_LIMITER"`. OPTIONAL on purpose: a
   * self-hosted Worker without the block, `wrangler dev`, the local viewer
   * stand-in and the tests all run without it, and absence means no limiting.
   * The brake protects the hosted deployment; it must never be a requirement.
   */
  GUIDE_CREATE_LIMITER?: RateLimit;
}

/**
 * The `simple.period` the `[[ratelimits]]` block declares, echoed to the client
 * as `Retry-After`. Not exported: workerd rejects any named export from the
 * entry module that is not a function or handler ("Incorrect type for map
 * entry"), and the runtime refuses to start — `wrangler deploy --dry-run` does
 * not catch that, only running the Worker does.
 */
const GUIDE_CREATE_RATE_LIMIT_PERIOD_SECONDS = 60;

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.');
  return (dot >= 0 && CONTENT_TYPES[key.slice(dot)]) || 'application/octet-stream';
}

/** Headers every /v1 asset carries: immutable (content-hashed names) and readable from any origin, including file:// documents (Origin: null). */
export function viewerAssetHeaders(key: string, extra?: Record<string, string>): Headers {
  const h = new Headers({
    'Content-Type': contentTypeFor(key),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Timing-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  return h;
}

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

/**
 * The brake on anonymous guide creation, alongside the handler's size cap.
 *
 * Guide creation is the one anonymous write this service accepts, so it is the
 * one route that is limited: reads are cheap and cached, delete already needs
 * the capability token issued at create, and preflights and viewer assets are
 * not writes at all. A compliant user shares a guide a handful of times an
 * hour; the configured 20 per minute per IP is far above that and only a
 * script hits it.
 *
 * Fails open in every direction it cannot resolve: no binding (self-host,
 * `wrangler dev`, tests), no `CF-Connecting-IP` (nothing is in front of the
 * Worker, so nothing to key on; behind Cloudflare that header is set at the
 * edge and a client cannot remove it), or a limiter that throws. A broken
 * brake must not stop people sharing guides.
 *
 * Returns the `429` to send, or `null` to let the create through.
 */
export async function rateLimitGuideCreate(req: Request, limiter: RateLimit | undefined): Promise<Response | null> {
  if (!limiter) return null;
  const ip = req.headers.get('CF-Connecting-IP');
  if (!ip) return null;
  try {
    const { success } = await limiter.limit({ key: ip });
    if (success) return null;
  } catch (error) {
    console.error('guides.show: rate limiter failed, allowing the create', error instanceof Error ? error.message : String(error));
    return null;
  }
  return json({ error: 'too many requests' }, 429, {
    ...GUIDE_SHARE_CORS_HEADERS,
    'Retry-After': String(GUIDE_CREATE_RATE_LIMIT_PERIOD_SECONDS),
  });
}

/** Keys are `v1/<file>`; reject anything that is not a plain nested filename. */
export function viewerKeyFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/v1/')) return null;
  const key = pathname.slice(1);
  if (key.length > 512) return null;
  if (key.includes('..') || key.includes('//') || key.endsWith('/') || key.includes('\\')) return null;
  if (!/^v1\/[A-Za-z0-9._\-\/]+$/.test(key)) return null;
  return key;
}

async function serveViewerAsset(req: Request, key: string, bucket: R2Bucket): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: viewerAssetHeaders(key) });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  const notFound = () => new Response('not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  const headersFor = (object: R2Object) => viewerAssetHeaders(key, { ETag: object.httpEtag, 'Content-Length': String(object.size) });
  if (req.method === 'HEAD') {
    const object = await bucket.head(key);
    return object ? new Response(null, { status: 200, headers: headersFor(object) }) : notFound();
  }
  const object = await bucket.get(key);
  return object ? new Response(object.body, { status: 200, headers: headersFor(object) }) : notFound();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith('/v1/')) {
      const key = viewerKeyFromPath(path);
      if (!key) return new Response('bad request', { status: 400 });
      return serveViewerAsset(req, key, env.VIEWER);
    }
    if (isGuideShareRoute(path)) {
      if (req.method === 'POST' && path === '/api/g') {
        const limited = await rateLimitGuideCreate(req, env.GUIDE_CREATE_LIMITER);
        if (limited) return limited;
      }
      // Shared guides. The handler pins this Worker's own /v1/ as the viewer
      // base and this origin as the canonical page URL, both taken from req.url.
      return handleGuideShareRequest(req, { store: new R2GuideStore(env.GUIDES), viewerManifest: GUIDE_VIEWER_MANIFEST });
    }
    if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
    if (path === '/healthz') return json({ ok: true });

    // Landing and any other static page.
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
