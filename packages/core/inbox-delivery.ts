export const INBOX_AUTO_SEND_AFTER_MS = 5 * 60_000;

export const INBOX_AUTO_SEND_ACK_NOTES = false;

export type InboxDeliverNowBy = "person" | "auto";

export type InboxDeliveryState = "delivered" | "undelivered" | "saved" | "queued" | "sending";

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

export interface InboxDeliveryConnection {
  busy: boolean | null;
  send_now: boolean;
  held?: boolean;
}

export interface InboxDeliveryInput {
  delivered: boolean;
  undelivered: boolean;
  stuck?: boolean;
  askerEnded: boolean;
  wakes: boolean;
  sendingNow: boolean;
  connection: InboxDeliveryConnection | null | undefined;
  waitingSince?: string | null;
  autoSince?: string | null;
  intoTurn?: boolean | null;
  nowBy?: InboxDeliverNowBy | null;
  nowAt?: string | null;
  autoSendAfterMs?: number | null;
}

export interface InboxDeliveryDecision {
  state: InboxDeliveryState;
  reason: InboxDeliveryReason;
  sendNow: boolean;
  wait?: { since: string; steerable: boolean; autoSendAt: string | null };
  autoAfterMin?: number;
  turnEnded?: boolean;
}

export function inboxDeliveryState(input: InboxDeliveryInput): InboxDeliveryDecision {
  const no = { sendNow: false };
  const marked = input.nowBy === "auto" && !!input.nowAt && !!input.waitingSince;
  const auto = marked && input.intoTurn !== false ? { autoAfterMin: wholeMinutes(input.waitingSince!, input.nowAt!) } : {};
  if (input.delivered) return { state: "delivered", reason: "delivered", ...no, ...auto, ...(marked && input.intoTurn === false ? { turnEnded: true } : {}) };
  if (input.stuck) return { state: "undelivered", reason: "stuck", ...no };
  if (input.undelivered) return { state: "undelivered", reason: "undelivered", ...no };
  if (input.askerEnded) return { state: "saved", reason: "ended", ...no };
  if (!input.wakes) return { state: "saved", reason: "reads", ...no };
  const connection = input.connection;
  if (connection === null) return { state: "queued", reason: "away", ...no };
  if (connection?.held === true) return { state: "queued", reason: "stopped", ...no };
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

export function inboxAutoSendAt(input: Pick<InboxDeliveryInput, "autoSince" | "nowBy" | "nowAt" | "sendingNow" | "connection" | "autoSendAfterMs">): string | null {
  const after = input.autoSendAfterMs;
  if (after == null || !(after >= 0) || !input.autoSince) return null;
  if (input.nowBy || input.nowAt || input.sendingNow) return null;
  if (input.connection?.busy !== true || !input.connection.send_now) return null;
  const start = Date.parse(input.autoSince);
  return Number.isFinite(start) ? new Date(start + after).toISOString() : null;
}

export function wholeMinutes(from: string, to: string | number): number {
  const a = Date.parse(from);
  const b = typeof to === "number" ? to : Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 60_000));
}

export function inboxAutoSendInMinutes(autoSendAt: string, now: number): number | null {
  const at = Date.parse(autoSendAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const left = at - now;
  return left < 60_000 ? 0 : Math.ceil(left / 60_000);
}

type AskingQuestionState = "open" | "picked" | "sent" | "closed" | "superseded";

export function inboxDefaultSkip<M>(_messages: readonly M[], _statesOf: (message: M) => readonly AskingQuestionState[]): boolean {
  return false;
}

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

export interface InboxRowDelivery {
  kind: "reply" | "message" | "ack";
  state: InboxDeliveryState;
  reason: InboxDeliveryReason;
  send_now: boolean;
  message_id: string;
  read_by?: string;
  at: string | null;
  host: string | null;
  name: string | null;
  another_session?: boolean;
  asking?: { host: string | null; name: string | null };
  waiting_since?: string;
  steerable?: boolean;
  auto_send_at?: string | null;
  auto_after_min?: number;
  turn_ended?: boolean;
}
