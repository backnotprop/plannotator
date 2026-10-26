/**
 * The Worker's entry: only the handlers (workerd refuses any other named
 * export of the main module). Everything else is in handler.ts.
 */
import { handleRequest, runRetention, type Env } from "./handler";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runRetention(env.COUNTS).catch(() => console.error("counts: retention_failed")));
  },
} satisfies ExportedHandler<Env>;
