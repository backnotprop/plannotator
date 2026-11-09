import { parseExtraOrigins } from "../core/cors";
import { handleRequest, type RateLimiter } from "../core/handler";
import { createThrottle } from "../core/throttle";
import { D1FeedbackStore } from "../stores/d1";

interface Env {
  FEEDBACK_DB: D1Database;
  /** Optional: the per-caller `[[ratelimits]]` binding in wrangler.toml. */
  FEEDBACK_RATE_LIMITER?: RateLimiter;
  /** Optional: the global ceiling `[[ratelimits]]` binding, one key for everyone. */
  FEEDBACK_GLOBAL_LIMITER?: RateLimiter;
  /** Optional: the only browser origins allowed to POST (none by default). */
  ALLOWED_ORIGINS?: string;
}

// Per isolate, in memory: 10 submissions per caller per 10 minutes (the
// owner's call; README.md). Soft: Cloudflare spreads one caller over many
// isolates. Nothing about the caller is written anywhere.
const throttle = createThrottle({ limit: 10, windowMs: 10 * 60 * 1000 });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      store: new D1FeedbackStore(env.FEEDBACK_DB),
      throttle,
      rateLimiter: env.FEEDBACK_RATE_LIMITER,
      globalRateLimiter: env.FEEDBACK_GLOBAL_LIMITER,
      ip: request.headers.get("CF-Connecting-IP"),
      extraOrigins: parseExtraOrigins(env.ALLOWED_ORIGINS),
    });
  },
};
