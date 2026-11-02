/**
 * Plannotator Inbox: Ask AI's routes. Off unless PLANNOTATOR_INBOX_ASK_AI is
 * set when the Inbox starts: off, every path here falls through to the
 * unknown-route 404, as if it did not exist.
 *
 *   GET  /api/inbox/ask                    `{ chats }`: every thread with a conversation, for the
 *                                          window's chat list
 *   GET  /api/inbox/threads/:id/ask        `{ subject, project, conversation, damaged?, running, can_ask, agent }`:
 *                                          null when none, the turn id being answered, whether the
 *                                          icons show, and who answers
 *   POST /api/inbox/threads/:id/ask        `{ turn_id, question, passage? }`: claim the owner's
 *                                          slot, save the question, wait for its client
 *   POST /api/inbox/threads/:id/ask/seen   `{ seen_at }`: the person saw the answers up to then
 *   POST /api/inbox/threads/:id/ask/stop   `{ turn_id }`: stop that turn, which needs no AI session,
 *                                          so a window opened after a reload can
 *   POST /api/inbox/threads/:id/ask/end    End conversation: stops the answer, and the file is
 *                                          deleted with no Undo
 *   /api/ai/*                              Ask AI's session and query routes (packages/ai/endpoints.ts)
 *   POST /api/inbox/ask/:session/api/ai/bridge/{poll,event}   the agent's client (inbox-ask-live.ts)
 *
 * Conversations are the person's alone, so every route but the client's two
 * answers only the person's own window: a tailnet guest gets `403 owner_only`
 * and anything but the window's page (an agent's curl, another site) gets
 * `403 window_only`, reads included. The client's routes sit behind the
 * connection routes' gate. `Sec-Fetch-Site: same-origin` is the browser's own mark,
 * which page script cannot set. Nothing here is on the phone's door. A change
 * tells the window (`event: ask`), which reads the conversation again.
 *
 * A file that can't be read answers `503 ask_unreadable`, and one that doesn't
 * parse `409 ask_damaged`, on every route but End and the thread's read: never
 * "no conversation". That read says `damaged: true` for one that doesn't parse,
 * so the window keeps its icon and the person can ask the question that sets it
 * aside. A question refused for that saves nothing and overwrites nothing. The
 * chat list leaves such a file out: it lists, and that thread's own read says why.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { inboxAgentName, type InboxThread } from "@plannotator/core/inbox-types";
import { isAIEndpointPath } from "@plannotator/ai/endpoints";
import { addInboxAskTurn, checkInboxAskInput, findInboxAskTurn, inboxAskFiles, inboxAskSummary, markInboxAskSeen, readInboxAsk, removeInboxAsk, updateInboxAskTurn, type InboxAskSummary } from "@plannotator/shared/inbox/ask";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxAskLive, type InboxAskClaim, type InboxAskContext, type InboxAskTimes } from "./inbox-ask-live";

export const INBOX_ASK_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/ask(?:\/(seen|stop|end))?$/;
export const INBOX_ASK_LIST_PATH = "/api/inbox/ask";

/**
 * Where the agent is told the question comes from. The subject is written by an
 * agent or the person and sits inside quotes the agent reads, so a quote, a
 * backslash or a new line in it can't end them.
 */
export function inboxAskSurface(subject: string | null, threadId: string): string {
  const name = (subject ?? "(no subject)").replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ").trim();
  return `Inbox thread "${name}" (${threadId})`;
}

/** Who answers in a thread: its owner's name as the thread shows it. */
function agentOf(thread: InboxThread, owner: { host: string | null; session: string } | null): { host: string | null; name: string } {
  const agents = thread.messages.filter((message) => message.author.kind === "agent");
  const wrote = (owner ? agents.filter((message) => message.author.kind === "agent" && message.author.session === owner.session) : agents).at(-1);
  const author = wrote?.author ?? { kind: "agent", host: owner?.host ?? null, name: null };
  return { host: (author as { host?: string | null }).host ?? owner?.host ?? null, name: inboxAgentName(author) };
}

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
  /** The Inbox's token, and the host of a session that can answer live: inbox-ask-live.ts. */
  token: string;
  hostOf: (session: string) => string | null;
  times?: InboxAskTimes;
}) {
  const { on, store, serverSession, json } = options;
  const live = createInboxAskLive({ token: options.token, dir: store.dir, hostOf: options.hostOf, onChange: options.onChange, times: options.times });
  const stopDeletions = store.onDeletion(() => live.sweep((threadId) => store.thread(threadId) !== null));

  const fromWindow = (req: Request): boolean => req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "same-origin";

  /** Whether this request may ask or read: the setting is on, and it is the owner's own window. */
  const allowed = (req: Request, via: "local" | "tailnet"): boolean => on && fromWindow(req) && !options.isGuest(req, via);

  const refuse = (req: Request, via: "local" | "tailnet"): void => {
    if (options.isGuest(req, via)) throw new InboxError("owner_only", "Only this computer's owner can use Ask AI from this Inbox.");
    if (!fromWindow(req)) throw new InboxError("window_only", "Ask AI answers only the Inbox window.");
  };

  const isOpen = (thread: InboxThread): boolean => {
    const last = thread.messages.at(-1);
    return !last || store.messageAnswerable(last.id);
  };
  /** Who a question goes to: an archived thread takes none. The icons keep the same rule. */
  const ownerOf = (thread: InboxThread) => (isOpen(thread) ? store.threadOwner(thread.thread_id) : null);

  /** A file is read again only when it changed: every list would otherwise read them all, on the server's one thread. */
  const summaries = new Map<string, { mtimeMs: number; size: number; summary: InboxAskSummary }>();
  const chats = () => {
    const files = inboxAskFiles(store.dir);
    for (const threadId of summaries.keys()) if (!files.some((file) => file.threadId === threadId)) summaries.delete(threadId);
    const rows = files.flatMap((file) => {
      const known = summaries.get(file.threadId);
      let summary = known?.mtimeMs === file.mtimeMs && known.size === file.size ? known.summary : null;
      if (!summary) {
        try {
          summary = inboxAskSummary(readInboxAsk(store.dir, file.threadId));
        } catch {
          return [];
        }
        if (!summary) return [];
        summaries.set(file.threadId, { mtimeMs: file.mtimeMs, size: file.size, summary });
      }
      const thread = store.thread(file.threadId);
      if (!thread) return [];
      return [{ thread_id: file.threadId, subject: thread.subject, project: thread.project.name, host: summary.host, at: summary.at, unread: summary.unread, answering: live.running(file.threadId) !== null }];
    });
    return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  };

  const route = async (req: Request, url: URL, via: "local" | "tailnet"): Promise<Response | null> => {
    if (!on) return null;
    if (url.pathname === INBOX_ASK_LIST_PATH) {
      refuse(req, via);
      return req.method === "GET" ? json({ chats: chats() }) : json({ error: "Use GET." }, 405);
    }
    const match = INBOX_ASK_PATH.exec(url.pathname);
    if (!match) return null;
    refuse(req, via);
    const threadId = match[1]!;
    const action = match[2];
    if (!action && req.method === "GET") {
      const thread = store.thread(threadId);
      if (!thread) return json({ error: `No thread ${threadId}.`, code: "thread_not_found" }, 404);
      const owner = ownerOf(thread);
      // Not a refusal: the window needs its icon and a word to the person, or the question that sets the file aside can't be asked.
      let conversation: ReturnType<typeof readInboxAsk> = null;
      let damaged = false;
      try {
        conversation = readInboxAsk(store.dir, threadId);
      } catch (error) {
        if (!(error instanceof InboxError) || error.code !== "ask_damaged") throw error;
        damaged = true;
      }
      return json({
        serverSession,
        subject: thread.subject,
        project: thread.project.name,
        conversation,
        ...(damaged ? { damaged: true } : {}),
        running: live.running(threadId),
        can_ask: !!owner && live.canAnswer(owner.session),
        agent: agentOf(thread, owner ?? store.threadOwner(threadId)),
      });
    }
    if (req.method !== "POST") return json({ error: action ? "Use POST." : "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    const thread = store.thread(threadId);
    if (!thread) return json({ error: `No thread ${threadId}.`, code: "thread_not_found" }, 404);

    if (action === "end") {
      live.stopThread(threadId);
      const ended = removeInboxAsk(store.dir, threadId);
      if (ended) options.onChange(threadId);
      return json({ ok: true, ended });
    }
    if (action === "stop") {
      // Only the turn this window means: a Stop that arrives late must not stop the next question.
      if (typeof body.turn_id !== "string" || live.running(threadId) !== body.turn_id) return json({ ok: true, stopped: false });
      live.stopThread(threadId);
      // A question stopped before any word (still connecting, or waiting on a busy agent) has nothing else to say so.
      updateInboxAskTurn(store.dir, threadId, body.turn_id, { stopped: true });
      options.onChange(threadId);
      return json({ ok: true, stopped: true });
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
    if (known && (known.turn.answer !== undefined || known.turn.stopped)) return json({ ...known, provider_id: null });
    // Re-read at each ask: a thread handed off since the last question has a new owner, and a retry goes to it.
    const owner = ownerOf(thread);
    if (!owner) {
      if (known) return json({ ...known, provider_id: null, reason: "no_live_path" });
      if (!isOpen(thread)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to ask.");
      throw new InboxError("ask_no_owner", "No agent owns this thread: nothing was saved.");
    }

    // The slot first: a question the agent can't take now is refused with nothing saved.
    let claim: InboxAskClaim;
    try {
      claim = live.claim({ threadId, turnId: input.id, session: owner.session });
    } catch (error) {
      if (known && error instanceof InboxError && error.code === "ask_no_live_path") return json({ ...known, provider_id: null, reason: "no_live_path" });
      throw error;
    }
    if (known && live.answering(claim)) return json({ ...known, provider_id: null, running: true });

    let saved: NonNullable<typeof known>;
    try {
      const moved = known && (known.turn.session !== owner.session || known.turn.host !== owner.host);
      if (moved) saved = updateInboxAskTurn(store.dir, threadId, input.id, { session: owner.session, host: owner.host }) ?? known;
      else if (known) saved = known;
      else {
        const added = addInboxAskTurn(store.dir, threadId, { ...input, at: new Date().toISOString(), session: owner.session, host: owner.host });
        saved = { conversation: added.conversation, turn: added.turn };
        options.onChange(threadId);
      }
    } catch (error) {
      live.free(claim);
      throw error;
    }
    // The turn stays saved either way: with no connection the window offers to ask again, or to reply in the thread.
    if (await live.connected(claim)) return json({ ...saved, provider_id: live.providerOf(claim) });
    return json({ ...saved, provider_id: null, reason: "no_connection" });
  };

  /** The JSON body of a request that goes on to an endpoint, or null. */
  const bodyOf = async (req: Request): Promise<Record<string, unknown> | null> => {
    const body: unknown = await req.clone().json().catch(() => null);
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  };
  const withBody = (req: Request, body: unknown): Request => new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal: req.signal });

  /**
   * An AI session answers one turn, the one POST /ask named. It runs on that
   * turn's bridge and its surface comes from the thread here, so nothing the
   * window sends can put another thread's name in front of the agent, or bind
   * the session to a later turn on the same agent.
   */
  const sessionRequest = async (req: Request): Promise<Request | Response> => {
    const held = live.heldBy((await bodyOf(req))?.providerId);
    const thread = held && store.thread(held.slot.threadId);
    if (!held || !thread) return json({ error: "This question waited too long to reach the agent. Ask again.", code: "ask_slot_lost" }, 409);
    const context: InboxAskContext = { mode: "annotate", turn: held.slot.turnId, annotate: { content: "", filePath: inboxAskSurface(thread.subject, thread.thread_id) } };
    return withBody(req, { providerId: held.bridge.providerId, context });
  };

  /** Everything `/api/ai` does for Ask AI, behind the same gate: only the owner's own window. */
  const aiRoute = async (req: Request, path: string, via: "local" | "tailnet"): Promise<Response | null> => {
    if (!on || !isAIEndpointPath(path) || path.startsWith("/api/ai/bridge/")) return null;
    refuse(req, via);
    const endpoint = live.endpoints[path] as (request: Request) => Promise<Response> | Response;
    if (req.method !== "POST") return endpoint(req);
    if (path === "/api/ai/session") {
      const made = await sessionRequest(req);
      return made instanceof Response ? made : endpoint(made);
    }
    // No supersede here: it frees the slot and leaves the bridge's ask running, so the next question finds it `busy`.
    if (path === "/api/ai/abort") {
      const body = await bodyOf(req);
      if (body?.reason !== undefined) return endpoint(withBody(req, { ...body, reason: undefined }));
    }
    return endpoint(req);
  };

  return {
    allowed,
    route,
    aiRoute,
    /** On every poll answer, and what ends a held poll. */
    waits: (session: string) => live.waits(session),
    onWaits: live.onWaits,
    hostRoute: live.hostRoute,
    stop() {
      stopDeletions();
      live.stop();
    },
  };
}
