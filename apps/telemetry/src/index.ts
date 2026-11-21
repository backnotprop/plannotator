/**
 * The Worker's entry: only the fetch handler (workerd refuses any other named
 * export of the main module). Everything else is in handler.ts.
 */
import { handleRequest } from "./handler";

export default {
  fetch(req: Request, env: { DB: D1Database }): Promise<Response> {
    // GET /totals is answered from the Cache API for 5 minutes (handler.ts).
    return handleRequest(req, env, Date.now(), caches.default);
  },
} satisfies ExportedHandler<{ DB: D1Database }>;
