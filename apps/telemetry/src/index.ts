import { handleRequest } from "./handler";

export default {
  fetch(req: Request, env: { DB: D1Database }): Promise<Response> {
    return handleRequest(req, env, Date.now(), caches.default);
  },
} satisfies ExportedHandler<{ DB: D1Database }>;
