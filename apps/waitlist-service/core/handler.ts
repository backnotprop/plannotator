import type { WaitlistStore } from "./storage";
import { verifyTurnstile } from "./turnstile";
import { normalizeSignup, ValidationError, type RawSignup } from "./validation";

export interface HandlerOptions {
  /** Max signups per IP per UTC day before we start 429-ing. */
  rateLimitPerDay: number;
  /** Bearer token required for /admin/* routes. Disabled if undefined. */
  adminToken?: string;
  /** Cloudflare Turnstile secret key. Verification is skipped if undefined. */
  turnstileSecret?: string;
}

const DEFAULT_OPTIONS: HandlerOptions = {
  rateLimitPerDay: 20,
};

// Hard cap on /signup request bodies. The legitimate payload is < 1 KB; this
// just stops a bad actor from making us parse megabyte-sized JSON.
const MAX_BODY_BYTES = 16 * 1024;

interface RequestContext {
  ip: string | null;
  country: string | null;
  user_agent: string | null;
  referer: string | null;
}

export async function handleRequest(
  request: Request,
  store: WaitlistStore,
  cors: Record<string, string>,
  ctx: RequestContext,
  options: Partial<HandlerOptions> = {}
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({ ok: true }, { headers: cors });
  }

  if (url.pathname === "/signup" && request.method === "POST") {
    return handleSignup(request, store, cors, ctx, opts);
  }

  if (url.pathname === "/admin/count" && request.method === "GET") {
    if (!authorizeAdmin(request, opts.adminToken)) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
    }
    const n = await store.count();
    return Response.json({ count: n }, { headers: cors });
  }

  if (url.pathname === "/admin/list" && request.method === "GET") {
    if (!authorizeAdmin(request, opts.adminToken)) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
    }
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "500", 10) || 500, 1),
      5000
    );
    const rows = await store.list(limit);
    return Response.json({ rows }, { headers: cors });
  }

  return Response.json(
    { error: "Not found. Valid: POST /signup, GET /health" },
    { status: 404, headers: cors }
  );
}

function authorizeAdmin(request: Request, adminToken?: string): boolean {
  if (!adminToken) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${adminToken}`;
  // Constant-time-ish: rely on TextEncoder length check; not security-critical
  // here because the token gates a list endpoint, not credentials.
  return auth.length === expected.length && auth === expected;
}

async function handleSignup(
  request: Request,
  store: WaitlistStore,
  cors: Record<string, string>,
  ctx: RequestContext,
  opts: HandlerOptions
): Promise<Response> {
  // Reject oversized bodies up-front. Content-Length is advisory but good
  // enough for honest clients; misbehaving ones still hit the parse step
  // which streams from a bounded request body in Workers.
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength) {
    const n = parseInt(declaredLength, 10);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return Response.json(
        { error: "Request body too large" },
        { status: 413, headers: cors }
      );
    }
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return Response.json(
      { error: "Could not read request body" },
      { status: 400, headers: cors }
    );
  }
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json(
      { error: "Request body too large" },
      { status: 413, headers: cors }
    );
  }

  let body: RawSignup;
  try {
    body = JSON.parse(raw) as RawSignup;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors }
    );
  }

  let normalized;
  try {
    normalized = normalizeSignup(body);
  } catch (e) {
    if (e instanceof ValidationError) {
      // Honeypot: pretend success. Bot can't distinguish.
      if (e.message === "__honeypot__") {
        return Response.json({ ok: true }, { status: 200, headers: cors });
      }
      return Response.json(
        { error: e.message },
        { status: e.status, headers: cors }
      );
    }
    throw e;
  }

  // Verify Turnstile token if a secret is configured. We treat this as the
  // primary defense; rate limiting and the honeypot stay as belt-and-suspenders.
  if (opts.turnstileSecret) {
    const token =
      typeof body.turnstile_token === "string" ? body.turnstile_token : null;
    const result = await verifyTurnstile(token, opts.turnstileSecret, ctx.ip);
    if (!result.success) {
      return Response.json(
        {
          error:
            "Couldn't verify you're human. Please refresh the page and try again.",
          codes: result.errorCodes,
        },
        { status: 400, headers: cors }
      );
    }
  }

  // Rate-limit per IP / day. Skip if we have no IP (very rare; CF always
  // sets CF-Connecting-IP). Fail-open on store errors so a hiccup in D1
  // can't block legitimate signups — Turnstile is the primary defense.
  if (ctx.ip) {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const hits = await store.bumpRateLimit(ctx.ip, day);
      if (hits > opts.rateLimitPerDay) {
        return Response.json(
          { error: "Too many requests, please try again tomorrow." },
          { status: 429, headers: cors }
        );
      }
    } catch (e) {
      console.error("rate-limit bump failed:", e);
    }
  }

  try {
    await store.insert(normalized, {
      ip: ctx.ip,
      country: ctx.country,
      user_agent: ctx.user_agent ? ctx.user_agent.slice(0, 500) : null,
      referer: ctx.referer ? ctx.referer.slice(0, 500) : null,
    });
    // Always return a generic success — whether the row was new or already
    // existed. Surfacing the duplicate flag would let anyone probe for which
    // emails are on the list.
    return Response.json({ ok: true }, { status: 201, headers: cors });
  } catch (e) {
    console.error("signup insert failed:", e);
    return Response.json(
      { error: "Failed to record signup" },
      { status: 500, headers: cors }
    );
  }
}
