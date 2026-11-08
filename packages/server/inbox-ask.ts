/**
 * Plannotator Inbox: Ask AI's routes, on in every Inbox (approval
 * "inbox-ask-ai-flow", addendum 2026-11-07: no switch).
 *
 * Show me (code review in the Inbox, approval "shape-in-code-review"): a POST
 * with `kind: "show_me"` and `show_me: { review, file, lines, round, words? }`
 * is a question that asks the agent for a Shape. Only while Code review is on
 * (`409 code_review_off`), about a review of this thread, and its `question`
 * is exactly `inboxShowMeRequest`'s words. The board comes back the way any
 * board does (`plannotator shape update --thread`); a read names it on the turn
 * (`showMeShapes`), so nothing is kept twice. A dragged box's Show me sends its
 * picture as `show_me.part.picture` (a data: URL): it is kept in the board's
 * folder (`keepPicture`) and the stored request names the file.
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
import { inboxReviewRound, inboxShowMeRequest, type InboxShowMePart, type InboxShowMeTarget } from "@plannotator/core/inbox-review";
import { addInboxAskTurn, checkInboxAskInput, checkInboxShowMeInput, findInboxAskTurn, inboxAskFiles, inboxAskSummary, markInboxAskSeen, readInboxAsk, removeInboxAsk, showMeShapes, type ShowMeBoardVersion, updateInboxAskTurn, type InboxAskConversation, type InboxAskSummary } from "@plannotator/shared/inbox/ask";
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

/** A review message as Show me needs it: its thread, its title and the files of its diff. */
export interface InboxAskReview {
  threadId: string;
  title: string;
  files: readonly string[];
}

export function createInboxAsk(options: {
  /** Code review (Settings → Capabilities): Show me exists only while it is on. Absent: off. */
  codeReviewOn?: () => boolean;
  /**
   * The boards are on (Shape's switch or Code review): a Show me from a board is taken only then. Absent: off.
   */
  boardsOn?: () => boolean;
  /** A review message (`guide.review`) by id, or null when the message is not one. Absent: none. */
  reviewOf?: (messageId: string) => InboxAskReview | "not_a_review" | null;
  /** A thread's Shape boards, and when each version was written, to name the board each Show me made. Absent: none. */
  boardsOf?: (threadId: string) => { id: string; versions: ShowMeBoardVersion[] }[];
  /** A Show me's box picture, kept in that board's folder: the file's full path, or null. Absent: no picture is kept. */
  keepPicture?: (board: string, picture: string) => Promise<string | null>;
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
  const { store, serverSession, json } = options;
  const live = createInboxAskLive({ token: options.token, dir: store.dir, hostOf: options.hostOf, onChange: options.onChange, times: options.times });
  const stopDeletions = store.onDeletion(() => live.sweep((threadId) => store.thread(threadId) !== null));

  /** A conversation as the window reads it: each Show me names the board it made (`showMeShapes`). */
  const withShapes = <T extends InboxAskConversation | null>(conversation: T, threadId: string): T => {
    if (!conversation?.turns.some((turn) => turn.kind === "show_me")) return conversation;
    const shapes = showMeShapes(conversation.turns, options.boardsOf?.(threadId) ?? [], live.running(threadId));
    return { ...conversation, turns: conversation.turns.map((turn) => (shapes.has(turn.id) ? { ...turn, shape: shapes.get(turn.id)! } : turn)) };
  };

  const fromWindow = (req: Request): boolean => req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "same-origin";

  /** Whether this request may ask or read: the owner's own window. */
  const allowed = (req: Request, via: "local" | "tailnet"): boolean => fromWindow(req) && !options.isGuest(req, via);

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
        conversation: withShapes(conversation, threadId),
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
    // Show me: a question that asks the agent to draw, about a review of this thread. Only while Code review is on.
    const showMe = checkInboxShowMeInput(body);
    let showMeFields: { kind: "show_me"; show_me: InboxShowMeTarget; again_shape?: string } | null = null;
    let boxPicture: string | null = null;
    let requestOf: ((target: InboxShowMeTarget) => string) | null = null;
    if (showMe) {
      const asked = showMe.target;
      // A review's Show me needs Code review; a board's, the boards (Shape or Code review).
      if (!(asked.part ? (options.boardsOn?.() ?? false) : (options.codeReviewOn?.() ?? false))) return json({ error: "Code review is off in this Inbox (Settings → Capabilities).", code: "code_review_off" }, 409);
      if (asked.part && !(options.boardsOf?.(threadId) ?? []).some((board) => board.id === asked.part!.board)) {
        throw new InboxError("validation_error", `show_me.part: ${asked.part.board} is not a board of this thread.`, { field: "show_me" });
      }
      const review = asked.review === null ? null : (options.reviewOf?.(asked.review) ?? null);
      if (asked.review !== null) {
        if (review === null) return json({ error: `No review ${asked.review} here.`, code: "not_found" }, 404);
        if (review === "not_a_review" || review.threadId !== threadId) return json({ error: `${asked.review} is not a review in this thread.`, code: "not_a_review" }, 409);
        if (asked.file !== null && !review.files.includes(asked.file)) {
          throw new InboxError("validation_error", `show_me.file: ${asked.file} is not a file of this review.`, { field: "show_me" });
        }
      }
      if (showMe.againShape !== undefined && !(options.boardsOf?.(threadId) ?? []).some((board) => board.id === showMe.againShape)) {
        throw new InboxError("validation_error", `again_shape: ${showMe.againShape} is not a board of this thread.`, { field: "again_shape" });
      }
      // The round is the Inbox's to say: the review's place among the thread's reviews.
      // A box's picture is kept apart (below, with the turn): the window's request is written without it.
      const { picture: _picture, ...part } = asked.part ?? {};
      boxPicture = asked.part?.picture ?? null;
      const target: InboxShowMeTarget = { ...asked, ...(asked.part ? { part: part as InboxShowMePart } : {}), round: asked.review === null ? 1 : inboxReviewRound(thread.messages, asked.review) };
      requestOf = (shown) => inboxShowMeRequest({ target: shown, title: review && review !== "not_a_review" ? review.title : "", threadId, ...(showMe.againShape !== undefined ? { again: showMe.againShape } : {}) });
      if (input.question !== requestOf(target)) throw new InboxError("validation_error", "question: a Show me's question is its request, as inboxShowMeRequest writes it.", { field: "question" });
      showMeFields = { kind: "show_me", show_me: target, ...(showMe.againShape !== undefined ? { again_shape: showMe.againShape } : {}) };
    }
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
        // A box's Show me: its picture goes in the board's folder, and the request the agent reads names the file.
        // A picture it cannot save leaves its line out: the Show me still goes.
        const board = boxPicture ? showMeFields?.show_me.part?.board : undefined;
        const kept = board && options.keepPicture ? await options.keepPicture(board, boxPicture!).catch(() => null) : null;
        if (kept && showMeFields?.show_me.part && requestOf) {
          const show_me: InboxShowMeTarget = { ...showMeFields.show_me, part: { ...showMeFields.show_me.part, picture: kept } };
          showMeFields = { ...showMeFields, show_me };
          input.question = requestOf(show_me);
        }
        const added = addInboxAskTurn(store.dir, threadId, { ...input, ...showMeFields, at: new Date().toISOString(), session: owner.session, host: owner.host });
        saved = { conversation: added.conversation, turn: added.turn };
        options.onChange(threadId);
      }
    } catch (error) {
      live.free(claim);
      throw error;
    }
    // The turn stays saved either way: with no connection the window offers to ask again, or to reply in the thread.
    const shown = { ...saved, conversation: withShapes(saved.conversation, threadId) };
    if (await live.connected(claim)) return json({ ...shown, provider_id: live.providerOf(claim) });
    return json({ ...shown, provider_id: null, reason: "no_connection" });
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
    if (!isAIEndpointPath(path) || path.startsWith("/api/ai/bridge/")) return null;
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
