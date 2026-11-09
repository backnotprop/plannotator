import { corsHeaders, isAllowedOrigin } from "./cors";
import { limitKey } from "./ip";
import type { FeedbackStore } from "./storage";
import type { Throttle } from "./throttle";
import { normalizeFeedback, ValidationError } from "./validation";

/**
 * The Worker's one route. Everything else is 404 (another path) or 405
 * (another method on this one). It writes; it never answers with data.
 */
export const FEEDBACK_PATH = "/feedback";

/** The global ceiling's one key: every caller shares it. */
export const GLOBAL_LIMIT_KEY = "all";

/** The legitimate body is under 5 KB (a 4,000-character message and short labels). */
export const MAX_BODY_BYTES = 16 * 1024;

/** The Cloudflare rate-limit binding's shape (`[[ratelimits]]` in wrangler.toml). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface HandlerDeps {
  store: FeedbackStore;
  /** The in-isolate per-IP throttle. */
  throttle: Throttle;
  /** The Cloudflare rate-limit binding, when configured, keyed per caller. */
  rateLimiter?: RateLimiter;
  /** A second binding, keyed by one constant: a ceiling on all submissions together (per Cloudflare location). */
  globalRateLimiter?: RateLimiter;
  /** The caller's IP (CF-Connecting-IP), used only as a throttle key in memory. Never stored. */
  ip: string | null;
  /** The only browser origins allowed (`ALLOWED_ORIGINS`); any other request with an Origin is 403. */
  extraOrigins?: readonly string[];
  now?: () => Date;
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function reply(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      ...(body === null ? {} : { "Content-Type": "application/json; charset=utf-8" }),
      ...extra,
    },
  });
}

/** Reads at most `max` bytes of the body; null once it is longer. */
async function readBounded(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

export async function handleRequest(request: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== FEEDBACK_PATH) return reply(404, { error: "Not found" });

  const origin = request.headers.get("Origin");
  if (origin !== null && !isAllowedOrigin(origin, deps.extraOrigins)) {
    return reply(403, { error: "Origin not allowed" });
  }
  const cors = corsHeaders(origin);

  if (request.method === "OPTIONS") return reply(204, null, cors);
  if (request.method !== "POST") {
    return reply(405, { error: "Use POST" }, { ...cors, Allow: "POST, OPTIONS" });
  }

  const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    return reply(415, { error: "Send a JSON body (Content-Type: application/json)" }, cors);
  }
  const declared = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return reply(413, { error: "Request body too large" }, cors);
  }

  // Limits before the body is read: a flood costs no parsing and no write.
  // Per caller (an IPv6 address counts by its /64), then one ceiling for everyone.
  if (deps.ip) {
    const key = limitKey(deps.ip);
    if (deps.rateLimiter) {
      try {
        const { success } = await deps.rateLimiter.limit({ key });
        if (!success) return reply(429, { error: "Too many requests. Try again in a minute." }, cors);
      } catch {
        // The binding failing open keeps feedback flowing; the throttle below still applies.
      }
    }
    if (!deps.throttle.allow(key)) {
      return reply(429, { error: "Too many requests. Try again later." }, cors);
    }
  }
  if (deps.globalRateLimiter) {
    try {
      const { success } = await deps.globalRateLimiter.limit({ key: GLOBAL_LIMIT_KEY });
      if (!success) return reply(429, { error: "Too many requests. Try again in a minute." }, cors);
    } catch {
      // Fails open, like the per-caller binding.
    }
  }

  let raw: string | null;
  try {
    raw = await readBounded(request, MAX_BODY_BYTES);
  } catch {
    return reply(400, { error: "Could not read the body" }, cors);
  }
  if (raw === null) return reply(413, { error: "Request body too large" }, cors);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reply(400, { error: "Invalid JSON body" }, cors);
  }

  let feedback;
  try {
    feedback = normalizeFeedback(parsed);
  } catch (error) {
    if (error instanceof ValidationError) return reply(error.status, { error: error.message }, cors);
    throw error;
  }

  try {
    await deps.store.insert({ ...feedback, created_at: (deps.now?.() ?? new Date()).toISOString() });
  } catch (error) {
    console.error("feedback insert failed:", error instanceof Error ? error.message : String(error));
    return reply(500, { error: "Could not save the feedback" }, cors);
  }
  // Nothing echoed back: the caller learns only that it was saved.
  return reply(201, { ok: true }, cors);
}
