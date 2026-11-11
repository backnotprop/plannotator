/** Ask AI's routes. Every route but the agent client's two answers only the person's own window (`owner_only`, `window_only`). */

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

/** The subject sits inside quotes the agent reads, so a quote, backslash or new line in it must not end them. */
export function inboxAskSurface(subject: string | null, threadId: string): string {
  const name = (subject ?? "(no subject)").replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ").trim();
  return `Inbox thread "${name}" (${threadId})`;
}

function agentOf(thread: InboxThread, owner: { host: string | null; session: string } | null): { host: string | null; name: string } {
  const agents = thread.messages.filter((message) => message.author.kind === "agent");
  const wrote = (owner ? agents.filter((message) => message.author.kind === "agent" && message.author.session === owner.session) : agents).at(-1);
  const author = wrote?.author ?? { kind: "agent", host: owner?.host ?? null, name: null };
  return { host: (author as { host?: string | null }).host ?? owner?.host ?? null, name: inboxAgentName(author) };
}

export interface InboxAskReview {
  threadId: string;
  title: string;
  files: readonly string[];
}

export function createInboxAsk(options: {
  codeReviewOn?: () => boolean;
  boardsOn?: () => boolean;
  reviewOf?: (messageId: string) => InboxAskReview | "not_a_review" | null;
  boardsOf?: (threadId: string) => { id: string; versions: ShowMeBoardVersion[] }[];
  keepPicture?: (board: string, picture: string) => Promise<string | null>;
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  isGuest: (req: Request, via: "local" | "tailnet") => boolean;
  onChange: (threadId: string) => void;
  token: string;
  hostOf: (session: string) => string | null;
  times?: InboxAskTimes;
}) {
  const { store, serverSession, json } = options;
  const live = createInboxAskLive({ token: options.token, dir: store.dir, hostOf: options.hostOf, onChange: options.onChange, times: options.times });
  const stopDeletions = store.onDeletion(() => live.sweep((threadId) => store.thread(threadId) !== null));

  const withShapes = <T extends InboxAskConversation | null>(conversation: T, threadId: string): T => {
    if (!conversation?.turns.some((turn) => turn.kind === "show_me")) return conversation;
    const shapes = showMeShapes(conversation.turns, options.boardsOf?.(threadId) ?? [], live.running(threadId));
    return { ...conversation, turns: conversation.turns.map((turn) => (shapes.has(turn.id) ? { ...turn, shape: shapes.get(turn.id)! } : turn)) };
  };

  const fromWindow = (req: Request): boolean => req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "same-origin";

  const allowed = (req: Request, via: "local" | "tailnet"): boolean => fromWindow(req) && !options.isGuest(req, via);

  const refuse = (req: Request, via: "local" | "tailnet"): void => {
    if (options.isGuest(req, via)) throw new InboxError("owner_only", "Only this computer's owner can use Ask AI from this Inbox.");
    if (!fromWindow(req)) throw new InboxError("window_only", "Ask AI answers only the Inbox window.");
  };

  const isOpen = (thread: InboxThread): boolean => {
    const last = thread.messages.at(-1);
    return !last || store.messageAnswerable(last.id);
  };
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
    const showMe = checkInboxShowMeInput(body);
    let showMeFields: { kind: "show_me"; show_me: InboxShowMeTarget; again_shape?: string } | null = null;
    let boxPicture: string | null = null;
    let requestOf: ((target: InboxShowMeTarget) => string) | null = null;
    if (showMe) {
      const asked = showMe.target;
      const codeReview = options.codeReviewOn?.() ?? false;
      const boards = options.boardsOn?.() ?? false;
      if (asked.part ? !boards && !codeReview : !codeReview) return json({ error: "Code review is off in this Inbox (Settings → Capabilities).", code: "code_review_off" }, 409);
      if (!boards) return json({ error: "Shape is off in this Inbox (Settings → Capabilities).", code: "shape_off" }, 409);
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
    const shown = { ...saved, conversation: withShapes(saved.conversation, threadId) };
    if (await live.connected(claim)) return json({ ...shown, provider_id: live.providerOf(claim) });
    return json({ ...shown, provider_id: null, reason: "no_connection" });
  };

  const bodyOf = async (req: Request): Promise<Record<string, unknown> | null> => {
    const body: unknown = await req.clone().json().catch(() => null);
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  };
  const withBody = (req: Request, body: unknown): Request => new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal: req.signal });

  /** One AI session answers one turn, the one POST /ask named; the surface comes from the thread here, never from the window. */
  const sessionRequest = async (req: Request): Promise<Request | Response> => {
    const held = live.heldBy((await bodyOf(req))?.providerId);
    const thread = held && store.thread(held.slot.threadId);
    if (!held || !thread) return json({ error: "This question waited too long to reach the agent. Ask again.", code: "ask_slot_lost" }, 409);
    const context: InboxAskContext = { mode: "annotate", turn: held.slot.turnId, annotate: { content: "", filePath: inboxAskSurface(thread.subject, thread.thread_id) } };
    return withBody(req, { providerId: held.bridge.providerId, context });
  };

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
    waits: (session: string) => live.waits(session),
    onWaits: live.onWaits,
    hostRoute: live.hostRoute,
    stop() {
      stopDeletions();
      live.stop();
    },
  };
}
