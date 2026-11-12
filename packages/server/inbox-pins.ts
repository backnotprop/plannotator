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
