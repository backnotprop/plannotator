import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { inboxSnoozeDelay, type InboxSnooze } from "@plannotator/core/inbox-snooze";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_SNOOZE_HELD = "held";
export const INBOX_SNOOZE_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/snooze$/;

export function createInboxSnoozes(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
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
      const root = store.message(match[1]!);
      if (!root || root.thread_id !== match[1]) throw new InboxError("thread_not_found", `No thread ${match[1]}.`);
      store.clearSnooze(match[1]!);
      return json({ snoozed: null });
    }
    if (url.searchParams.has(INBOX_SNOOZE_HELD)) return json({ snoozed: wire(store.setHeldSnooze(match[1]!, body.until, body.at)) });
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
