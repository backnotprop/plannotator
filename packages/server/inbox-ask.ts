/**
 * Plannotator Inbox: Ask AI's routes. Off unless PLANNOTATOR_INBOX_ASK_AI is
 * set when the Inbox starts: off, every path here falls through to the
 * unknown-route 404, as if it did not exist.
 *
 *   GET  /api/inbox/threads/:id/ask        `{ conversation }` (null when none)
 *   POST /api/inbox/threads/:id/ask        `{ turn_id, question, passage? }`: save a question for
 *                                          the session that owns the thread now
 *   POST /api/inbox/threads/:id/ask/seen   `{ seen_at }`: the person saw the answers up to then
 *   POST /api/inbox/threads/:id/ask/end    End conversation: the file is deleted, with no Undo
 *
 * Conversations are the person's alone, so every route answers only the
 * person's own window: a tailnet guest gets `403 owner_only` and anything but
 * the window's page (an agent's curl, another site) gets `403 window_only`,
 * reads included. `Sec-Fetch-Site: same-origin` is the browser's own mark,
 * which page script cannot set. Nothing here is on the phone's door. A change
 * tells the window (`event: ask`), which reads the conversation again.
 *
 * A file that can't be read answers `503 ask_unreadable`, and one that doesn't
 * parse `409 ask_damaged`, on every route but End: never "no conversation".
 * A question refused for that saves nothing and overwrites nothing.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { addInboxAskTurn, checkInboxAskInput, findInboxAskTurn, markInboxAskSeen, readInboxAsk, removeInboxAsk } from "@plannotator/shared/inbox/ask";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_ASK_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/ask(?:\/(seen|end))?$/;

export function createInboxAsk(options: {
  /** PLANNOTATOR_INBOX_ASK_AI, read once at start. */
  on: boolean;
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /** A tailnet request from someone other than this computer's owner. */
  isGuest: (req: Request, via: "local" | "tailnet") => boolean;
  /** A conversation changed: the windows' streams say so. */
  onChange: (threadId: string) => void;
}) {
  const { on, store, serverSession, json } = options;

  const fromWindow = (req: Request): boolean => req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "same-origin";

  /** Whether this request may ask or read: the setting is on, and it is the owner's own window. */
  const allowed = (req: Request, via: "local" | "tailnet"): boolean => on && fromWindow(req) && !options.isGuest(req, via);

  const refuse = (req: Request, via: "local" | "tailnet"): void => {
    if (options.isGuest(req, via)) throw new InboxError("owner_only", "Only this computer's owner can use Ask AI from this Inbox.");
    if (!fromWindow(req)) throw new InboxError("window_only", "Ask AI answers only the Inbox window.");
  };

  const route = async (req: Request, url: URL, via: "local" | "tailnet"): Promise<Response | null> => {
    if (!on) return null;
    const match = INBOX_ASK_PATH.exec(url.pathname);
    if (!match) return null;
    refuse(req, via);
    const threadId = match[1]!;
    const action = match[2];
    if (!action && req.method === "GET") {
      if (!store.thread(threadId)) return json({ error: `No thread ${threadId}.`, code: "thread_not_found" }, 404);
      return json({ serverSession, conversation: readInboxAsk(store.dir, threadId) });
    }
    if (req.method !== "POST") return json({ error: action ? "Use POST." : "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    const thread = store.thread(threadId);
    if (!thread) return json({ error: `No thread ${threadId}.`, code: "thread_not_found" }, 404);

    if (action === "end") {
      const ended = removeInboxAsk(store.dir, threadId);
      if (ended) options.onChange(threadId);
      return json({ ok: true, ended });
    }
    if (action === "seen") {
      const seenAt = typeof body.seen_at === "string" && Number.isFinite(Date.parse(body.seen_at)) ? body.seen_at : null;
      if (!seenAt) throw new InboxError("validation_error", "seen_at: the answered_at of the newest answer the window showed.", { field: "seen_at" });
      const seen = markInboxAskSeen(store.dir, threadId, seenAt);
      if (seen.changed) options.onChange(threadId);
      return json({ conversation: seen.conversation });
    }

    const input = checkInboxAskInput(body);
    // Before the gates: a retry of a saved turn gets that turn, even if the thread was archived since.
    const known = findInboxAskTurn(store.dir, threadId, input.id);
    if (known) return json(known);
    const last = thread.messages.at(-1);
    if (last && !store.messageAnswerable(last.id)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to ask.");
    // Re-read at each ask: a thread handed off since the last question has a new owner.
    const owner = store.threadOwner(threadId);
    if (!owner) throw new InboxError("ask_no_owner", "No agent owns this thread: nothing was saved.");
    const saved = addInboxAskTurn(store.dir, threadId, { ...input, at: new Date().toISOString(), session: owner.session, host: owner.host });
    if (saved.added) options.onChange(threadId);
    return json({ turn: saved.turn, conversation: saved.conversation });
  };

  return { allowed, route };
}
