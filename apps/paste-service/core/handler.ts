import type { PasteStore } from "./storage";
import { corsHeaders } from "./cors";
import type {
  ReviewSession,
  CreateReviewSessionRequest,
  AddAnnotationsRequest,
} from "@plannotator/ui/types";

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
          "Cache-Control": "private, no-store",
        },
      }
    );
  }

  // Review Session endpoints
  if (url.pathname === "/api/review-session" && request.method === "POST") {
    return handleCreateSession(request, store, cors, options);
  }

  const sessionMatch = url.pathname.match(
    /^\/api\/review-session\/([A-Za-z0-9]{6,16})$/
  );
  if (sessionMatch && request.method === "GET") {
    return handleGetSession(sessionMatch[1], store, cors);
  }

  const annotationsMatch = url.pathname.match(
    /^\/api\/review-session\/([A-Za-z0-9]{6,16})\/annotations$/
  );
  if (annotationsMatch && request.method === "PATCH") {
    return handleAddAnnotations(annotationsMatch[1], request, store, cors, options);
  }

  return Response.json(
    {
      error:
        "Not found. Valid paths: POST /api/paste, GET /api/paste/:id, POST /api/review-session, GET /api/review-session/:id, PATCH /api/review-session/:id/annotations",
    },
    { status: 404, headers: cors }
  );
}

// Review Session handlers

async function handleCreateSession(
  request: Request,
  store: PasteStore,
  cors: Record<string, string>,
  options?: Partial<PasteOptions>
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  let body: CreateReviewSessionRequest;
  try {
    body = (await request.json()) as CreateReviewSessionRequest;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors }
    );
  }

  if (!body.plan || typeof body.plan !== "string") {
    return Response.json(
      { error: 'Missing or invalid "plan" field' },
      { status: 400, headers: cors }
    );
  }

  if (body.plan.length > opts.maxSize) {
    return Response.json(
      { error: `Plan too large (max ${Math.round(opts.maxSize / 1024)} KB)` },
      { status: 413, headers: cors }
    );
  }

  try {
    const id = generateId();
    const now = Date.now();

    const session: ReviewSession = {
      id,
      plan: body.plan,
      annotations: [],
      globalAttachments: body.globalAttachments || [],
      diffContexts: [],
      createdAt: now,
      lastUpdatedAt: now,
      expiresAt: now + opts.ttlSeconds * 1000,
      reviewerCount: 0,
      version: 1,
    };

    await store.putSession(id, session, opts.ttlSeconds);

    // Generate share URL
    const origin = request.headers.get("origin") || "https://share.plannotator.ai";
    const shareUrl = `${origin}/s/${id}`;

    return Response.json(
      { session, shareUrl },
      { status: 201, headers: cors }
    );
  } catch (e) {
    console.error("Failed to create session:", e);
    return Response.json(
      { error: "Failed to create session" },
      { status: 500, headers: cors }
    );
  }
}

async function handleGetSession(
  id: string,
  store: PasteStore,
  cors: Record<string, string>
): Promise<Response> {
  try {
    const session = await store.getSession(id);

    if (!session) {
      return Response.json(
        { error: "Session not found or expired" },
        { status: 404, headers: cors }
      );
    }

    return Response.json(
      { session },
      {
        headers: {
          ...cors,
          "Cache-Control": "private, no-store", // Prevent caching — sessions are mutable
        },
      }
    );
  } catch (e) {
    console.error("Failed to fetch session:", e);
    return Response.json(
      { error: "Failed to fetch session" },
      { status: 500, headers: cors }
    );
  }
}

async function handleAddAnnotations(
  id: string,
  request: Request,
  store: PasteStore,
  cors: Record<string, string>,
  options?: Partial<PasteOptions>
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  let body: AddAnnotationsRequest;
  try {
    body = (await request.json()) as AddAnnotationsRequest;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors }
    );
  }

  if (!Array.isArray(body.annotations)) {
    return Response.json(
      { error: 'Missing or invalid "annotations" field' },
      { status: 400, headers: cors }
    );
  }

  try {
    const session = await store.getSession(id);

    if (!session) {
      return Response.json(
        { error: "Session not found or expired" },
        { status: 404, headers: cors }
      );
    }

    // Optimistic locking check
    if (body.expectedVersion !== session.version) {
      return Response.json(
        {
          error:
            "Version conflict — session was updated by another reviewer. Please refresh and try again.",
        },
        { status: 409, headers: cors }
      );
    }

    // Merge new annotations (deduplicate by originalText + type + text)
    const merged = [...session.annotations];
    const existingSet = new Set(
      merged.map((a) => `${a.originalText}|${a.type}|${a.text || ""}`)
    );

    const newAnnotations = body.annotations.filter((ann) => {
      const key = `${ann.originalText}|${ann.type}|${ann.text || ""}`;
      return !existingSet.has(key);
    });

    merged.push(...newAnnotations);

    // Track unique reviewers
    const reviewers = new Set(
      merged.map((a) => a.author).filter((author): author is string => Boolean(author))
    );

    // Merge global attachments (deduplicate by path)
    const globalAttachments = [...(session.globalAttachments || [])];
    if (body.globalAttachments?.length) {
      const existingPaths = new Set(globalAttachments.map((g) => g.path));
      const newAttachments = body.globalAttachments.filter(
        (g) => !existingPaths.has(g.path)
      );
      globalAttachments.push(...newAttachments);
    }

    // Build updated diff contexts array
    const diffContexts = merged.map((a) => a.diffContext || null);

    const updatedSession: ReviewSession = {
      ...session,
      annotations: merged,
      globalAttachments,
      diffContexts: diffContexts.some((d) => d !== null) ? diffContexts : [],
      lastUpdatedAt: Date.now(),
      reviewerCount: reviewers.size,
      version: session.version + 1,
    };

    const success = await store.updateSession(id, updatedSession, opts.ttlSeconds);

    if (!success) {
      return Response.json(
        {
          error:
            "Update failed — session was modified by another reviewer. Please refresh.",
        },
        { status: 409, headers: cors }
      );
    }

    return Response.json({ session: updatedSession }, { status: 200, headers: cors });
  } catch (e) {
    console.error("Failed to add annotations:", e);
    return Response.json(
      { error: "Failed to add annotations" },
      { status: 500, headers: cors }
    );
  }
}
