/**
 * Plannotator Inbox: tags on threads (approval "inbox-thread-tags", step 1). A tag is an initiative
 * (`POST /api/inbox/initiatives` makes one; `POST /api/inbox/initiatives/:id` renames, deletes and restores it,
 * with the Board on or off). The window's route (same origin for every POST, as every window write; the page's
 * `serverSession`; the owner over the tailnet like every window route):
 *
 *   POST /api/inbox/threads/:id/tags   `{ tag: "ini_…", on: boolean }`: Add tag, untick, Remove from; `{ tags }`, the thread's tags
 *
 * The person's marks live in `inbox/tags.json`, outside the event log (shared/inbox/thread-tags.ts): agents,
 * the MCP, search and the phone's event stream never see them. The list model carries the live tags (`tags`) and
 * each row's (`row.tags`), and a change tells every window (`event: tags`, as `event: pins`). The device door does
 * not forward it, and a linked machine's forward never carries it.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_THREAD_TAGS_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/tags$/;

export function createInboxThreadTags(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { store, serverSession, json } = options;

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_THREAD_TAGS_PATH.exec(url.pathname);
    if (!match) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.on !== "boolean") throw new InboxError("validation_error", "on: a boolean.", { field: "on" });
    return json({ tags: store.setThreadTag(match[1]!, body.tag, body.on) });
  };

  return { route };
}
