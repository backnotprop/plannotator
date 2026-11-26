/**
 * Plannotator Inbox: the person did something in a thread that no other write records (approval
 * "inbox-recent-activity-filter"; the record is shared's inbox/acted.ts). The window's route (same origin for every
 * POST, as every window write; the page's `serverSession`):
 *
 *   POST /api/inbox/threads/:id/acted   `{}`: the person played a film there now; `{ ok: true }`
 *
 * Opening a thread rides the opening look (`POST /seen { opened: true }`) and drafts ride their own saves, so this is
 * the one write of its own. The id may be a linked machine's thread (the merged list reads the note for its row).
 * Not on the device door. Bun only.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { isInboxId } from "@plannotator/core/inbox-types";
import type { InboxActed } from "@plannotator/shared/inbox/acted";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

export const INBOX_ACTED_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/acted$/;

export function createInboxActedRoute(options: {
  acted: InboxActed;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { acted, serverSession, json } = options;
  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_ACTED_PATH.exec(url.pathname);
    if (!match) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (!isInboxId("msg", match[1])) return json({ error: "Not a thread id.", code: "validation_error" }, 422);
    acted.note(match[1]!);
    return json({ ok: true });
  };
  return { route };
}
