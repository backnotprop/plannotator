/**
 * The Worker's entry: only the fetch handler (workerd refuses any other named
 * export of the main module). Everything else is in handler.ts.
 */
import { handleRequest } from "./handler";

export default {
  fetch(req: Request, env: { DB: D1Database }): Promise<Response> {
    return handleRequest(req, env);
  },
} satisfies ExportedHandler<{ DB: D1Database }>;
