/**
 * Power Up in the Inbox's reviews (the PR page and a thread's guided review): the window's semantic-diff worker posts
 * the engine's unsure calls to `/api/sem-diff/opinion` on its own origin, as code review's does, and the window reads
 * `/api/sem-diff/opinion/settings` to know whether a key is set. Both are answered by the shared
 * `answerSemDiffOpinionRequest` (packages/shared/sem-diff-opinion.ts) over this computer's data dir, the one code
 * review reads, so a key saved in code review's Settings powers up the Inbox too. Bun only: Pi has no Inbox.
 *
 * Guards: another site's page is refused (as `/api/inbox/sem-diff`); a write to the key (settings POST and DELETE)
 * must look like the window's own (`isWindowRequest`: its Origin and this run's `serverSession`, which the window
 * always sends), so the person sees no extra step. Not a door route: a linked computer or a phone's door gets a 404,
 * since the key and the provider call are this computer's. The Cloudflare door (the person's own window) asks and
 * reads like this computer's window, but cannot write the key (`local_only`, as Cloudflare's own settings).
 */
import { answerSemDiffOpinionRequest } from "@plannotator/shared/sem-diff-opinion";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest, isWindowRequest } from "./inbox-cross-site";

const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export const POWER_UP_WINDOW_ONLY_BODY = { error: "The Power Up key is changed from the Inbox window.", code: "window_only" } as const;
/** The Cloudflare door's key write: the same words and code as Cloudflare's own settings (inbox.ts, CF_ACCESS_ROUTE). */
export const POWER_UP_LOCAL_ONLY_BODY = { error: "The Power Up key changes only on this computer or over your tailnet.", code: "local_only" } as const;

export interface PowerUpRouteContext {
  dataDir: string;
  serverSession: string;
  /** The request came through the device door (a linked computer, a phone). */
  fromDoor: boolean;
  /**
   * The request came through the Cloudflare door (the person's own window over Cloudflare Access). Its ask and its
   * settings read are answered, as on this computer: they never return the key, and a review opened there is powered
   * up like one opened here. Its key write is refused, as Cloudflare's own settings are: the key is changed only on
   * this computer or over the tailnet.
   */
  fromCloudflare?: boolean;
  /** Tests only: the provider's fetch. Default: the global fetch. */
  fetch?: typeof fetch;
}

export async function powerUpRoute(req: Request, path: string, context: PowerUpRouteContext): Promise<Response> {
  if (context.fromDoor) return answer({ error: "Not found", code: "not_found" }, 404);
  if (isCrossSiteRequest(req)) return answer(INBOX_CROSS_SITE_BODY, 403);
  const method = req.method;
  let body: unknown = null;
  if (method === "POST" || method === "DELETE") {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  }
  const keyWrite = path === "/api/sem-diff/opinion/settings" && (method === "POST" || method === "DELETE");
  if (keyWrite && context.fromCloudflare) return answer(POWER_UP_LOCAL_ONLY_BODY, 403);
  if (keyWrite && !isWindowRequest(req, body && typeof body === "object" ? (body as Record<string, unknown>) : {}, context.serverSession)) {
    return answer(POWER_UP_WINDOW_ONLY_BODY, 403);
  }
  // The window's `serverSession` is the Inbox's, not the provider's: it never reaches the key file.
  if (body && typeof body === "object" && "serverSession" in body) {
    const { serverSession: _session, ...rest } = body as Record<string, unknown>;
    body = rest;
  }
  const reply = await answerSemDiffOpinionRequest(path, method, async () => body, context.dataDir, context.fetch ?? fetch);
  return answer(reply.body, reply.status);
}
