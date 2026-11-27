/**
 * Linear hover cards on the Inbox server. The read itself (the query, the
 * parsers, the cache, the key) is packages/shared/linear-cards.ts, which the
 * plan, annotate and review servers of both runtimes use too; it is re-exported
 * here. `withLinearCards` puts Linear in front of `createRefCards`, so the
 * Inbox's `GET /api/inbox/ref?url=` answers a Linear issue link too (one hook
 * line in inbox.ts), and `linearRefsRoute` serves `GET /api/inbox/linear-refs`
 * (`{ serverSession, workspace, teams, key }`: which bare identifiers the window
 * links, and whether Linear took the key; one more hook in inbox.ts).
 */

import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import type { LinearCards } from "@plannotator/shared/linear-cards";

export * from "@plannotator/shared/linear-cards";

/**
 * `GET /api/inbox/linear-refs`: `{ serverSession, workspace, teams, key }` (`key`: the `LinearKeyVerdict`),
 * `{ workspace: null, teams: [], key: "none" }` without a key. The window's read guard (another site's request `403 cross_origin`); not on the device door (not in its
 * allowlist). Null for any other path.
 */
export async function linearRefsRoute(
  req: Request,
  path: string,
  linear: LinearCards | null,
  serverSession: string,
  json: (body: unknown, status?: number) => Response,
): Promise<Response | null> {
  if (path !== "/api/inbox/linear-refs") return null;
  if (req.method !== "GET") return json({ error: "Use GET." }, 405);
  if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
    return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
  }
  const refs = linear ? await linear.issueRefs() : null;
  const key = linear ? await linear.keyVerdict() : "none";
  return json({ serverSession, workspace: refs?.workspace ?? null, teams: refs?.teams ?? [], key });
}
