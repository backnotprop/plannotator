/**
 * Plannotator Paste Worker
 *
 * Lightweight KV-backed paste service for short share URLs.
 * Stores compressed plan data and returns short IDs.
 *
 * Routes:
 *   POST /api/paste        - Store compressed data, returns { id, url }
 *   GET  /api/paste/:id    - Retrieve stored compressed data
 *
 * Deploy this worker to paste.plannotator.ai (or your own domain).
 * Self-hosters can point PLANNOTATOR_PASTE_URL to their own instance.
 */

interface Env {
  PASTE_KV: KVNamespace;
  /** Comma-separated allowed origins, defaults to share.plannotator.ai + localhost */
  ALLOWED_ORIGINS?: string;
}

const BASE_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function getAllowedOrigins(env: Env): string[] {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map(o => o.trim());
  }
  return ['https://share.plannotator.ai', 'http://localhost:3001'];
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = getAllowedOrigins(env);
  const headers: Record<string, string> = { ...BASE_CORS_HEADERS };

  if (allowed.includes(origin) || allowed.includes('*')) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

/**
 * Generate a short URL-safe ID (8 chars ≈ 48 bits of entropy).
 * Uses Web Crypto so it works in the edge runtime.
 */
function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // POST /api/paste — store compressed plan payload, return short ID
    if (url.pathname === '/api/paste' && request.method === 'POST') {
      try {
        const body = (await request.json()) as { data?: unknown };

        if (!body.data || typeof body.data !== 'string') {
          return Response.json(
            { error: 'Missing or invalid "data" field' },
            { status: 400, headers: cors }
          );
        }

        // 512 KB limit — generous for compressed plan data (most plans are <50 KB)
        if (body.data.length > 524_288) {
          return Response.json(
            { error: 'Payload too large (max 512 KB compressed)' },
            { status: 413, headers: cors }
          );
        }

        const id = generateId();

        // Store with 90-day TTL
        await env.PASTE_KV.put(`paste:${id}`, body.data, {
          expirationTtl: 90 * 24 * 60 * 60,
        });

        // Return only the id — the client constructs the full URL using its own
        // shareBaseUrl, so self-hosted deployments work without reconfiguration.
        return Response.json(
          { id },
          { status: 201, headers: cors }
        );
      } catch {
        return Response.json(
          { error: 'Failed to store paste' },
          { status: 500, headers: cors }
        );
      }
    }

    // GET /api/paste/:id — retrieve stored compressed data
    const pasteMatch = url.pathname.match(/^\/api\/paste\/([A-Za-z0-9]{6,16})$/);
    if (pasteMatch && request.method === 'GET') {
      const id = pasteMatch[1];
      const data = await env.PASTE_KV.get(`paste:${id}`);

      if (!data) {
        return Response.json(
          { error: 'Paste not found or expired' },
          { status: 404, headers: cors }
        );
      }

      return Response.json(
        { data },
        {
          headers: {
            ...cors,
            'Cache-Control': 'public, max-age=3600',
          },
        }
      );
    }

    return Response.json(
      { error: 'Not found. Valid paths: POST /api/paste, GET /api/paste/:id' },
      { status: 404, headers: cors }
    );
  },
};
