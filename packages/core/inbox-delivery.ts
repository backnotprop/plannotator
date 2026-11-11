/**
 * Where the person's latest sent item is: the one rule behind the line under
 * their reply in the thread (packages/inbox/deliveryLine.ts) and the glyph on
 * the list row (`InboxListRow.delivery`, approval "inbox-row-delivery",
 * "Ticks"), so a row and its thread never disagree. Pure, browser-safe.
 */

/**
 * How long a reply (a message, a Re-ask note) waits on a busy session before it
 * goes into the running turn by itself, exactly as if the person pressed Send
 * now (owner approval "inbox-busy-agent-reply", 2026-10-21). Only where Send
 * now is possible (the session's connection says `send_now`). The server
 * marks it (`deliver_now_by: "auto"`). Measured from the first time the
 * server saw that session busy, with Send now possible, while the item waited
 * for it (not from `created_at`: a reply left for an ended session, or a
 * message moved to another session, starts the wait when its session is
 * busy). The clock lives in the server's memory, so an Inbox restart or the
 * session going away starts it again: the wait is never shorter.
 */
export const INBOX_AUTO_SEND_AFTER_MS = 5 * 60_000;

/**
 * Whether the note that carries a 👍 Looks good goes into a running turn by
 * itself after the wait, like a reply. False, the owner's decision
 * (2026-10-21, approval "inbox-busy-agent-reply": "a thumbs-up isn't worth
 * interrupting a turn"): a 👍 waits for the turn to end, in the server's
 * marking and in every line that says what happens next. The one switch.
 */
export const INBOX_AUTO_SEND_ACK_NOTES = false;

/** Who asked for an item to go into the running turn: the person's Send now, or the Inbox after the wait. */
export type InboxDeliverNowBy = "person" | "auto";

/** delivered ✓✓, not delivered (a warning), saved ✓ (an agent reads it later), queued (a clock), sending (dots). */
export type InboxDeliveryState = "delivered" | "undelivered" | "saved" | "queued" | "sending";

/**
 * Which case of the rule decided the state, so a client words it exactly as
 * the thread does: `delivered`, `undelivered` (the addressed session stopped
 * before it took it), `stuck` (not delivered: its session's connection took
 * it and stopped mid-delivery, so that session never gets it), `ended` (saved: the session that asked has ended),
 * `reads` (saved: an agent that reads the thread), `sending_now` (Send now
 * pressed), `working` (queued: its session is in a turn), `idle` (sending:
 * the session is idle, the turn goes now), `away` (queued: its session does
 * not poll now), `next_turn` (queued: the Inbox does not know the session's
 * state), `ack_pending` (a 👍 inside its Undo window), `stopped` (queued:
 * Claude Code refused it after the person stopped that session, and holds it
 * until they type there; #2780, approval "inbox-stopped-reply").
 */
export type InboxDeliveryReason =
  | "delivered"
  | "undelivered"
  | "stuck"
  | "ended"
  | "reads"
  | "sending_now"
  | "working"
  | "idle"
  | "away"
  | "next_turn"
  | "ack_pending"
  | "stopped";

/** How the session the item goes to is connected now: the fields the rule reads. */
export interface InboxDeliveryConnection {
  /** A turn runs now; null when the connection does not say. */
  busy: boolean | null;
  /** Its connection can deliver into a running turn. */
  send_now: boolean;
  /** Claude Code refused a reply and holds the session's replies until the person types there (`held`). Absent: no. */
  held?: boolean;
}

export interface InboxDeliveryInput {
  /** It reached the session (or an agent read it). */
  delivered: boolean;
  /** A message addressed to a session that stopped before it took it (after the asker grace). */
  undelivered: boolean;
  /** Its session's connection took it and stopped while delivering it: that session never gets it. Absent: no. */
  stuck?: boolean;
  /** The session that asked has ended (a reply). */
  askerEnded: boolean;
  /** The session it goes to is woken by its connection. */
  wakes: boolean;
  /** The person pressed Send now (`deliver_now_at`). */
  sendingNow: boolean;
  /** Undefined: not known (not read yet, an older Inbox); null: it does not poll now. */
  connection: InboxDeliveryConnection | null | undefined;
  /**
   * When it began to wait on a busy session (the server's clock; after the
   * mark, the item's `wait_started_at`). Absent: no wait is shown.
   */
  waitingSince?: string | null;
  /**
   * When the clock toward going in by itself started: the first time the
   * server saw the session busy with Send now possible while it waited.
   * Absent: it does not go in by itself (yet).
   */
  autoSince?: string | null;
  /**
   * Delivered after an automatic mark: whether it went into a running turn
   * (`delivery.into_turn`). False: it waited for the turn to end (the
   * session's own Ask question held it). Absent: not known.
   */
  intoTurn?: boolean | null;
  /** Who set `deliver_now_at`, kept after a failed attempt cleared it (`deliver_now_by`). */
  nowBy?: InboxDeliverNowBy | null;
  /** When it was asked to go now (`deliver_now_at`). */
  nowAt?: string | null;
  /** The server's wait before it goes in by itself (`INBOX_AUTO_SEND_AFTER_MS`); absent or null: never (an older Inbox). */
  autoSendAfterMs?: number | null;
}

export interface InboxDeliveryDecision {
  state: InboxDeliveryState;
  reason: InboxDeliveryReason;
  /** Offer Send now: the session works and its connection can take the item mid-turn. */
  sendNow: boolean;
  /**
   * `reason: "working"`: it waits on a busy session ("Undelivered N min"),
   * since `waitingSince`; `steerable`: its connection can put it into the
   * running turn (the badge is blue, else grey: it cannot go in sooner);
   * `autoSendAt`: when it goes in by itself, null when it will not (the
   * connection cannot, or an automatic attempt already ran).
   */
  wait?: { since: string; steerable: boolean; autoSendAt: string | null };
  /** It went (or is going) into the turn by itself, after this many whole minutes. */
  autoAfterMin?: number;
  /** Delivered after an automatic mark, but at the end of the turn (not into it). */
  turnEnded?: boolean;
}

export function inboxDeliveryState(input: InboxDeliveryInput): InboxDeliveryDecision {
  const no = { sendNow: false };
  // Went (or is going) in by itself: the line says so once it is delivered. Only when it went into the
  // running turn: one the session's own Ask question held waited for the turn to end, and says that.
  const marked = input.nowBy === "auto" && !!input.nowAt && !!input.waitingSince;
  const auto = marked && input.intoTurn !== false ? { autoAfterMin: wholeMinutes(input.waitingSince!, input.nowAt!) } : {};
  if (input.delivered) return { state: "delivered", reason: "delivered", ...no, ...auto, ...(marked && input.intoTurn === false ? { turnEnded: true } : {}) };
  if (input.stuck) return { state: "undelivered", reason: "stuck", ...no };
  if (input.undelivered) return { state: "undelivered", reason: "undelivered", ...no };
  if (input.askerEnded) return { state: "saved", reason: "ended", ...no };
  if (!input.wakes) return { state: "saved", reason: "reads", ...no };
  const connection = input.connection;
  // Its session does not poll now: it waits for the session to come back, whatever was pressed before.
  if (connection === null) return { state: "queued", reason: "away", ...no };
  // Claude Code holds this session's replies until the person types there (they stopped it): nothing goes in
  // before that, Send now included, so the line says so instead of Queued or Sending.
  if (connection?.held === true) return { state: "queued", reason: "stopped", ...no };
  // Pressed, and the session can take it now. While it cannot (its own Ask this session question holds
  // it), the item waits for the turn to end: it reads as queued.
  if (input.sendingNow && !(connection?.busy === true && !connection.send_now)) return { state: "sending", reason: "sending_now", ...no, ...auto };
  if (connection?.busy === true) {
    const since = input.waitingSince ?? null;
    return {
      state: "queued",
      reason: "working",
      sendNow: connection.send_now && !input.sendingNow,
      ...(since ? { wait: { since, steerable: connection.send_now, autoSendAt: inboxAutoSendAt(input) } } : {}),
    };
  }
  if (connection?.busy === false) return { state: "sending", reason: "idle", ...no };
  return { state: "queued", reason: "next_turn", ...no };
}

/**
 * When an item waiting on a busy session goes into its turn by itself: the
 * server's clock (`autoSince`, started when it first saw the session busy
 * with Send now possible) plus the wait, only while its connection can take
 * it mid-turn and no attempt ran yet (`deliver_now_by` set, by the person or
 * by an earlier automatic one, never twice). Null otherwise.
 */
export function inboxAutoSendAt(input: Pick<InboxDeliveryInput, "autoSince" | "nowBy" | "nowAt" | "sendingNow" | "connection" | "autoSendAfterMs">): string | null {
  const after = input.autoSendAfterMs;
  if (after == null || !(after >= 0) || !input.autoSince) return null;
  if (input.nowBy || input.nowAt || input.sendingNow) return null;
  if (input.connection?.busy !== true || !input.connection.send_now) return null;
  const start = Date.parse(input.autoSince);
  return Number.isFinite(start) ? new Date(start + after).toISOString() : null;
}

/** Whole minutes from one time to another (never below 0). */
export function wholeMinutes(from: string, to: string | number): number {
  const a = Date.parse(from);
  const b = typeof to === "number" ? to : Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 60_000));
}

/**
 * How long until it goes in by itself, as the line words it: whole minutes,
 * rounded up ("in 2 min" at 1:01 to 2:00 left), 0 under a minute, null when
 * the time has passed (the server marks it at its next look).
 */
export function inboxAutoSendInMinutes(autoSendAt: string, now: number): number | null {
  const at = Date.parse(autoSendAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const left = at - now;
  return left < 60_000 ? 0 : Math.ceil(left / 60_000);
}

/** The question states a message holds, as the asking rule reads them. */
type AskingQuestionState = "open" | "picked" | "sent" | "closed" | "superseded";

/**
 * Whether a Send skips the questions it leaves unanswered, by default (no
 * choice made on the chip): never (approval "inbox-explicit-skip",
 * 2026-10-21). A question is skipped only when the person presses a Skip:
 * on its card, or "Skip them" on the chip for one Send. Kept, with its
 * arguments, for the callers that ask (the list row's delivery reads it).
 */
export function inboxDefaultSkip<M>(_messages: readonly M[], _statesOf: (message: M) => readonly AskingQuestionState[]): boolean {
  return false;
}

/**
 * The agent message whose session a Send with nothing riding on the latest
 * message reaches (the thread's `askingSessionOf` without words or files):
 * the last agent message a pick answers or, when the Send skips (`skip`),
 * an open question it skips; with none, the latest agent message. Null when
 * no agent wrote. One rule for the thread's "the session that asked" and the
 * list row's delivery, so the two name the same session.
 */
export function inboxAskingMessage<M extends { author: { kind: string } }>(
  messages: readonly M[],
  statesOf: (message: M) => readonly AskingQuestionState[],
  skip: boolean,
): M | null {
  let latest: M | null = null;
  let answered: M | null = null;
  for (const message of messages) {
    if (message.author.kind !== "agent") continue;
    latest = message;
    if (statesOf(message).some((state) => state === "picked" || (skip && state === "open"))) answered = message;
  }
  return answered ?? latest;
}

/**
 * The delivery of the person's latest sent item in a thread, on its list row
 * (`InboxListRow.delivery`): a reply, a message the person addressed to a
 * session (a thread they started, a New message, a reply sent to another
 * session), or a 👍 Looks good the Inbox sent through. Computed by the
 * server from the store and the live sessions with `inboxDeliveryState`.
 */
export interface InboxRowDelivery {
  kind: "reply" | "message" | "ack";
  state: InboxDeliveryState;
  reason: InboxDeliveryReason;
  /** Send now is offered in the thread (the row never offers it). */
  send_now: boolean;
  /** The person's message (a reply or message), or the agent message the 👍 is on. */
  message_id: string;
  /** Settled by a read of another agent than the one it was for: that agent's host. */
  read_by?: string;
  /** Delivered at (`delivered`), else null. */
  at: string | null;
  /** Whom it goes to: the host of the session (null for an agent without one). */
  host: string | null;
  /** An MCP agent's own name, when the thread names it by that. */
  name: string | null;
  /** It went to another session of the asker's own host ("Claude Code (another session)"). */
  another_session?: boolean;
  /**
   * `reason: "ended"`: the agent of the session that asked and has ended
   * (`inboxAskingMessage`), which the line names ("Saved for <it>. The
   * session that asked has ended…"). Absent otherwise.
   */
  asking?: { host: string | null; name: string | null };
  /**
   * `reason: "working"` (approval "inbox-busy-agent-reply"): it waits on a
   * busy session since then (the first time the server saw that session busy
   * while it waited), the row's "Undelivered N min". Absent otherwise
   * and from an older Inbox. Additive.
   */
  waiting_since?: string;
  /** With `waiting_since`: its connection can put it into the running turn (the badge is blue; grey otherwise). */
  steerable?: boolean;
  /** With `waiting_since`: when it goes into the running turn by itself; null when it will not. */
  auto_send_at?: string | null;
  /** It went (or is going) into the running turn by itself, after this many whole minutes of waiting. */
  auto_after_min?: number;
  /** Delivered after an automatic mark, but when the turn ended (the session's own Ask question held it). */
  turn_ended?: boolean;
}
