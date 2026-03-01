import type { PasteStore } from "./storage";
import { corsHeaders } from "./cors";

export interface PasteOptions {
  maxSize: number;
  ttlSeconds: number;
}

const DEFAULT_OPTIONS: PasteOptions = {
  maxSize: 524_288, // 512 KB
  ttlSeconds: 7 * 24 * 60 * 60, // 7 days
};

const ID_PATTERN = /^\/api\/paste\/([A-Za-z0-9]{6,16})$/;

/**
 * Generate a short URL-safe ID (8 chars, ~47.6 bits of entropy).
 * Uses Web Crypto with rejection sampling to avoid modulo bias.
 */
function generateId(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const limit = 256 - (256 % chars.length); // 248 — largest multiple of 62 that fits in a byte
  const id: string[] = [];
  while (id.length < 8) {
    const bytes = new Uint8Array(16); // oversample to minimize rounds
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit) {
        id.push(chars[b % chars.length]);
        if (id.length === 8) break;
      }
    }
  }
  return id.join("");
}

export async function createPaste(
  data: string,
  store: PasteStore,
  options: Partial<PasteOptions> = {}
): Promise<{ id: string }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!data || typeof data !== "string") {
    throw new PasteError('Missing or invalid "data" field', 400);
  }

  if (data.length > opts.maxSize) {
    throw new PasteError(
      `Payload too large (max ${Math.round(opts.maxSize / 1024)} KB compressed)`,
      413
    );
  }

  const id = generateId();
  await store.put(id, data, opts.ttlSeconds);
  return { id };
}

export async function getPaste(
  id: string,
  store: PasteStore
): Promise<string | null> {
  return store.get(id);
}

export class PasteError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/**
 * Shared HTTP request handler for the paste service.
 * Both Bun and Cloudflare targets delegate to this after wiring up their store.
 */
export async function handleRequest(
  request: Request,
  store: PasteStore,
  cors: Record<string, string>,
  options?: Partial<PasteOptions>
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === "/api/paste" && request.method === "POST") {
    let body: { data?: unknown };
    try {
      body = (await request.json()) as { data?: unknown };
    } catch {
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400, headers: cors }
      );
    }
    try {
      const result = await createPaste(body.data as string, store, options);
      return Response.json(result, { status: 201, headers: cors });
    } catch (e) {
      if (e instanceof PasteError) {
        return Response.json(
          { error: e.message },
          { status: e.status, headers: cors }
        );
      }
      return Response.json(
        { error: "Failed to store paste" },
        { status: 500, headers: cors }
      );
    }
  }

  const match = url.pathname.match(ID_PATTERN);
  if (match && request.method === "GET") {
    const data = await getPaste(match[1], store);
    if (!data) {
      return Response.json(
        { error: "Paste not found or expired" },
        { status: 404, headers: cors }
      );
    }
    return Response.json(
      { data },
      {
        headers: {
          ...cors,
          "Cache-Control": "public, max-age=3600",
        },
      }
    );
  }

  return Response.json(
    { error: "Not found. Valid paths: POST /api/paste, GET /api/paste/:id" },
    { status: 404, headers: cors }
  );
}
