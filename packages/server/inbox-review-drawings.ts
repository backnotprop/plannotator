/**
 * Plannotator Inbox: Show me's drawings (code review in the Inbox, approval
 * "shape-in-code-review", ac2). Bun only, as the Inbox is; the Pi server has
 * none of this.
 *
 *   POST /api/inbox/reviews/:msg/drawings   `{ turn, drawing, session? }`: the agent's drawing for a
 *                                           Show me (`plannotator review draw`): one per turn, never
 *                                           for a stopped turn, and from the turn's own session
 *                                           when the CLI knows its session. The connection routes' gate:
 *                                           this machine, no browser Origin, the Inbox's token.
 *   GET  /api/inbox/reviews/:msg/drawings   `{ serverSession, title, round, overview, drawings }`:
 *                                           the owner's own window (`Sec-Fetch-Site: same-origin`,
 *                                           never a tailnet guest), or the token (`plannotator review drawings`).
 *
 * While Code review is off neither exists: the unknown route answers, as in
 * the release before Show me. A drawing is checked by Shape's own rules (core's
 * `checkInboxDrawing`), so the agent hears at once which field is wrong, and
 * every part's code must be a file of the review's diff. Stored beside the
 * review (packages/shared/inbox/review-drawings.ts); the Ask turn it answers
 * gets its id (`drawing`) and the windows hear `event: ask` for the thread, so
 * the window reads the drawings again. No new event frame.
 */

import { parseDiffToFiles } from "@plannotator/core/diff-files";
import type { GuideSnapshot } from "@plannotator/core/guide-format";
import { checkInboxDrawing, inboxDrawingCodes, inboxDrawnViewOf, inboxReviewRound, inboxReviewDrawRefusal, type InboxReviewDrawing } from "@plannotator/core/inbox-review";
import { findInboxAskTurn, updateInboxAskTurn } from "@plannotator/shared/inbox/ask";
import { addInboxReviewDrawing, inboxDrawingId, readInboxReviewDrawings } from "@plannotator/shared/inbox/review-drawings";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { readInboxReviewSnapshot } from "./inbox-guides";

export const INBOX_REVIEW_DRAWINGS_PATH = /^\/api\/inbox\/reviews\/([A-Za-z0-9_]+)\/drawings$/;

/** The data-code values of a snapshot's drawn (html) overview diagram, or null when it has none. */
export function inboxOverviewCodes(snapshot: GuideSnapshot): string[] | null {
  const diagram = snapshot.guide.overview?.diagram;
  if (!diagram || diagram.kind !== "html") return null;
  return inboxDrawingCodes(inboxDrawnViewOf(diagram));
}

export function createInboxReviewDrawings(options: {
  store: InboxStore;
  serverSession: string;
  json: (body: unknown, status?: number) => Response;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  codeReviewOn: () => boolean;
  /** A tailnet request from someone other than this computer's owner. */
  isGuest: (req: Request, via: "local" | "tailnet") => boolean;
  /** A thread's Ask conversation changed: the windows' streams say `event: ask`. */
  onAskChange: (threadId: string) => void;
}) {
  const { store, json } = options;

  /** The review a path names, or the refusal. */
  const reviewOf = (messageId: string): { snapshot: GuideSnapshot; threadId: string; title: string; round: number } | Response => {
    const message = store.message(messageId);
    if (!message) return json({ error: inboxReviewDrawRefusal.not_found(messageId), code: "not_found" }, 404);
    if (!message.guide?.review || message.author.kind !== "agent") return json({ error: inboxReviewDrawRefusal.not_a_review(messageId), code: "not_a_review" }, 409);
    const snapshot = readInboxReviewSnapshot(store, messageId);
    if (!snapshot) return json({ error: inboxReviewDrawRefusal.not_found(messageId), code: "not_found" }, 404);
    const thread = store.thread(message.thread_id);
    const round = thread ? inboxReviewRound(thread.messages, messageId) : 1;
    return { snapshot, threadId: message.thread_id, title: message.guide.title, round };
  };

  const read = (messageId: string): Response => {
    const review = reviewOf(messageId);
    if (review instanceof Response) return review;
    const codes = inboxOverviewCodes(review.snapshot);
    return json({
      serverSession: options.serverSession,
      title: review.title,
      round: review.round,
      overview: codes ? { round: review.round, codes } : null,
      drawings: readInboxReviewDrawings(store.dir, messageId),
    });
  };

  const write = async (req: Request, messageId: string): Promise<Response> => {
    const body = await options.readBody(req);
    const review = reviewOf(messageId);
    if (review instanceof Response) return review;
    const turnId = typeof body.turn === "string" ? body.turn : "";
    let found: ReturnType<typeof findInboxAskTurn> = null;
    try {
      found = turnId ? findInboxAskTurn(store.dir, review.threadId, turnId) : null;
    } catch {
      found = null;
    }
    const turn = found?.turn;
    // The turn's own agent draws it: a CLI in another known session hears the turn is not its to answer.
    const session = typeof body.session === "string" && body.session ? body.session : null;
    if (!turn || turn.kind !== "show_me" || turn.show_me?.review !== messageId || (session && turn.session && session !== turn.session)) {
      return json({ error: inboxReviewDrawRefusal.turn_unknown(turnId || "(no --turn)"), code: "turn_unknown" }, 409);
    }
    if (turn.stopped) return json({ error: inboxReviewDrawRefusal.turn_stopped(turn.id), code: "turn_stopped" }, 409);
    // One drawing per Show me: another picture is another Show me (Show me again).
    if (turn.drawing) return json({ error: inboxReviewDrawRefusal.drawing_exists(turn.id), code: "drawing_exists" }, 409);
    const files = parseDiffToFiles(review.snapshot.review.rawPatch).map((file) => file.path);
    const checked = checkInboxDrawing(body.drawing, files);
    if (!checked.ok) return json({ error: inboxReviewDrawRefusal.invalid(checked.problems), code: "invalid", problems: checked.problems }, 422);
    const target = turn.show_me;
    const drawing: InboxReviewDrawing = {
      id: inboxDrawingId(),
      turn: turn.id,
      file: target.file,
      lines: target.lines,
      round: target.round,
      ...(target.words ? { words: target.words } : {}),
      ...(checked.title ? { title: checked.title } : {}),
      view: checked.view,
      at: new Date().toISOString(),
    };
    addInboxReviewDrawing(store.dir, messageId, drawing);
    updateInboxAskTurn(store.dir, review.threadId, turn.id, { drawing: drawing.id });
    options.onAskChange(review.threadId);
    return json({ ok: true, drawing });
  };

  const guard = async (run: () => Promise<Response> | Response): Promise<Response> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      const status = error.code === "validation_error" ? 422 : error.code === "drawings_full" ? 409 : 503;
      return json({ error: error.message, code: error.code }, status);
    }
  };

  return {
    /** The CLI's door: the gate in inbox.ts already checked this machine, no Origin and the token. */
    cliRoute(req: Request, path: string): Promise<Response> | Response | null {
      const match = INBOX_REVIEW_DRAWINGS_PATH.exec(path);
      if (!match || !options.codeReviewOn()) return null;
      if (req.method === "POST") return guard(() => write(req, match[1]!));
      if (req.method === "GET") return guard(() => read(match[1]!));
      return json({ error: "Use GET or POST." }, 405);
    },
    /** The owner's window: reads only. */
    windowRoute(req: Request, path: string, via: "local" | "tailnet"): Promise<Response> | Response | null {
      const match = INBOX_REVIEW_DRAWINGS_PATH.exec(path);
      if (!match || !options.codeReviewOn()) return null;
      if (options.isGuest(req, via)) return json({ error: "Only this computer's owner can read a review's drawings.", code: "owner_only" }, 403);
      if (req.headers.get("sec-fetch-site")?.trim().toLowerCase() !== "same-origin") {
        return json({ error: "A review's drawings answer only the Inbox window, or `plannotator review drawings`.", code: "window_only" }, 403);
      }
      if (req.method !== "GET") return json({ error: "Use GET. The agent sends a drawing with `plannotator review draw`." }, 405);
      return guard(() => read(match[1]!));
    },
  };
}
