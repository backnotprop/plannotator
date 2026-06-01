import { handleRequest } from "../core/handler";
import { corsHeaders, getAllowedOrigins } from "../core/cors";
import { D1WaitlistStore } from "../stores/d1";

interface Env {
  WAITLIST_DB: D1Database;
  ALLOWED_ORIGINS?: string;
  ADMIN_TOKEN?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const allowed = getAllowedOrigins(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin, allowed);

    // If the origin isn't allowed, fail before touching the DB.
    if (Object.keys(cors).length === 0 && request.method !== "GET") {
      return new Response("Forbidden", { status: 403 });
    }

    const store = new D1WaitlistStore(env.WAITLIST_DB);

    // Cloudflare populates request.cf with the geo + connection info.
    const cf = (request as unknown as { cf?: IncomingRequestCfProperties }).cf;
    const ip = request.headers.get("CF-Connecting-IP");

    return handleRequest(
      request,
      store,
      cors,
      {
        ip,
        country: cf?.country ?? null,
        user_agent: request.headers.get("User-Agent"),
        referer: request.headers.get("Referer"),
      },
      {
        adminToken: env.ADMIN_TOKEN,
        turnstileSecret: env.TURNSTILE_SECRET_KEY,
      }
    );
  },
};
