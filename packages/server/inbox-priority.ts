/**
 * Plannotator Inbox: the list's Priority group, the person's side. The
 * window's route (same origin for every POST, as every window write; the
 * page's `serverSession`; the owner over the tailnet like every window route):
 *
 *   POST /api/inbox/threads/:id/priority   `{ priority: true }`: Add to Priority; `{ before }`
 *   POST /api/inbox/threads/:id/priority   `{ priority: false }`: Remove from Priority; `{ before }`
 *   POST /api/inbox/threads/:id/priority   `{ restore: { at, off_at } }`: Undo, that `before` written back; `{ before }`
 *
 * The state lives in `inbox/priority.json`, outside the event log
 * (shared/inbox/priority.ts): agents, the MCP, search and the phone's event
 * stream never see it. The list model carries each row's `priority`, and a
 * change tells every window, and a linked machine that asks (`event:
 * priority`, as `event: pins` does). The phone's door carries the same write
 * (`POST threads/:id/priority` under an `idempotency_key`, contract 7.66). The
 * add lives on the thread's own machine (approval "inbox-linked-marks"): a
 * linked machine's window sends it here through its forward (`set` in
 * inbox-outbox.ts) and reads it back from this Inbox's list.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_PRIORITY_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/priority$/;

export function createInboxPriority(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { store, serverSession, json } = options;

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_PRIORITY_PATH.exec(url.pathname);
    if (!match) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    const hasPriority = body.priority !== undefined;
    const hasRestore = body.restore !== undefined;
    if (hasPriority === hasRestore) throw new InboxError("validation_error", "Send one of priority or restore.", { field: hasPriority ? "restore" : "priority" });
    if (hasRestore) return json({ before: store.restorePriority(match[1]!, body.restore) });
    if (typeof body.priority !== "boolean") throw new InboxError("validation_error", "priority: a boolean.", { field: "priority" });
    return json({ before: store.setPriority(match[1]!, body.priority) });
  };

  return { route };
}
