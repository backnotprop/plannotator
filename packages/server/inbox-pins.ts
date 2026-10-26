/**
 * Plannotator Inbox: threads pinned to the window's sidebar (approval
 * "inbox-pinned-threads", .product/approved/inbox-pinned-threads/). The
 * window's routes (same origin for every POST, as every window write; the
 * page's `serverSession`; the owner over the tailnet like every window route):
 *
 *   POST /api/inbox/threads/:id/pin   `{ pinned: boolean }`: pin (at the bottom) or unpin; `{ pins }`
 *   POST /api/inbox/pins              `{ order: [thread ids] }`: Move up and Move down; `{ pins }`
 *   POST /api/inbox/pins              `{ restore: { thread_id, index, pinned_at } }`: Unpin's Undo; `{ pins }`
 *
 * No limit on pins, and an archived thread stays pinned (the owner's
 * decisions). An order only permutes the threads pinned now: the pinned ones
 * it names come first, in that order, every other pin keeps its place after
 * them, and a named thread that is not pinned (another tab unpinned it) is
 * skipped, so a stale window never drops another tab's pin nor brings back
 * one it unpinned. Only a restore pins again: exactly one thread, at its old
 * index (clamped), with its original `pinned_at`. The list model carries `pins` (rows, in pin
 * order, every pinned thread whatever the project filter or `archived`), and
 * a change tells every window (`event: pins` on the window's stream, as
 * `event: drafts` does). Pins live in `inbox/pins.json`, outside the event
 * log (shared/inbox/pins.ts): agents, the MCP, search and the phone's event
 * stream never see them. The phone's door forwards `GET threads`, so a phone
 * reads `pins` with the list; it has no write row in v1.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import type { InboxPin } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_PIN_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/pin$/;
export const INBOX_PINS_PATH = "/api/inbox/pins";

export function createInboxPins(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { store, serverSession, json } = options;
  const wire = (pins: readonly InboxPin[]) => pins.map((pin) => ({ thread_id: pin.thread_id, pinned_at: pin.pinned_at }));

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_PIN_PATH.exec(url.pathname);
    if (!match && url.pathname !== INBOX_PINS_PATH) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (match) {
      if (typeof body.pinned !== "boolean") throw new InboxError("validation_error", "pinned: a boolean.", { field: "pinned" });
      return json({ pins: wire(store.setPinned(match[1]!, body.pinned)) });
    }
    const hasOrder = body.order !== undefined;
    const hasRestore = body.restore !== undefined;
    if (hasOrder === hasRestore) throw new InboxError("validation_error", "Send one of order or restore.", { field: hasOrder ? "restore" : "order" });
    return json({ pins: wire(hasRestore ? store.restorePin(body.restore) : store.orderPins(body.order)) });
  };

  return { route };
}
