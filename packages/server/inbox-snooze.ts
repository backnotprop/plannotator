/**
 * Plannotator Inbox: snoozing a thread (approval "inbox-snooze",
 * .product/approved/inbox-snooze/). The window's route, same origin for every
 * POST and with the page's `serverSession`, like every window write:
 *
 *   POST /api/inbox/threads/:id/snooze   `{ until: iso, at? }`: snooze it, or move its snooze; `{ until: null }`: Unsnooze. `{ snoozed }`
 *
 * `at` keeps an earlier snooze's own time (Undo). The door allows the route
 * and `DOOR_WRITES` classes it as a set, so a snooze lives on the thread's home
 * machine and reaches it through the forward and the outbox.
 *
 * Snoozes live in `inbox/snoozes.json`, outside the event log
 * (shared/inbox/snoozes.ts): an agent sees nothing. A change tells every
 * window (`event: snoozes`, as `event: pins` does) and every linked machine
 * that asked (`snoozes=1` on the stream), whose list of this machine's rows
 * otherwise moves only on a record. Whether a thread is snoozed is `until`
 * against the clock when a list is read, never this timer: it only tells the
 * open windows to read the list again at the nearest `until`.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { inboxSnoozeDelay, type InboxSnooze } from "@plannotator/core/inbox-snooze";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_SNOOZE_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/snooze$/;

export function createInboxSnoozes(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** Every window and linked machine listening: read the list again. */
  tell: () => void;
}) {
  const { store, serverSession, json, tell } = options;
  const wire = (snooze: InboxSnooze | null) => (snooze ? { until: snooze.until, at: snooze.at } : null);

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const match = INBOX_SNOOZE_PATH.exec(url.pathname);
    if (!match) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (body.until === null) {
      store.clearSnooze(match[1]!);
      return json({ snoozed: null });
    }
    return json({ snoozed: wire(store.setSnooze(match[1]!, body.until, body.at)) });
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const delay = inboxSnoozeDelay(store.snoozes().map((snooze) => snooze.until));
    if (delay === null) return;
    timer = setTimeout(() => {
      timer = null;
      tell();
      arm();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  };
  const stopListening = store.onSnoozesChange(() => {
    tell();
    arm();
  });
  arm();

  return {
    route,
    stop() {
      stopped = true;
      stopListening();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
