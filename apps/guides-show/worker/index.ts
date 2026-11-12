import { GUIDE_VIEWER_MANIFEST } from '@plannotator/core/guide-viewer-manifest';
import { GUIDE_SHARE_CORS_HEADERS, handleGuideShareRequest, isGuideShareRoute } from '../share/core/handler';
import { R2GuideStore } from '../share/stores/r2';

export interface Env {
  VIEWER: R2Bucket;
  GUIDES: R2Bucket;
  ASSETS: Fetcher;
  GUIDE_CREATE_LIMITER?: RateLimit;
}

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
      return handleGuideShareRequest(req, { store: new R2GuideStore(env.GUIDES), viewerManifest: GUIDE_VIEWER_MANIFEST });
    }
    if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
    if (path === '/healthz') return json({ ok: true });

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
