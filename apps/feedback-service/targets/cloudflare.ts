import { parseExtraOrigins } from "../core/cors";
import { handleRequest, type RateLimiter } from "../core/handler";
import { createThrottle } from "../core/throttle";
import { D1FeedbackStore } from "../stores/d1";

interface Env {
  FEEDBACK_DB: D1Database;
  FEEDBACK_RATE_LIMITER?: RateLimiter;
  FEEDBACK_GLOBAL_LIMITER?: RateLimiter;
  ALLOWED_ORIGINS?: string;
}

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
