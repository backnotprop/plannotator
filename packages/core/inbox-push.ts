/**
 * Plannotator Inbox: what a push to a paired phone says (adr/implementation/inbox-mobile.md,
 * section 4, "Push" and "Relay 1.1 and push 2").
 *
 * Pure: no store, no network, no encryption. The Inbox (packages/server/inbox-relay-push.ts)
 * gathers the facts from its store and calls these; the phone app's types and test vectors are
 * produced from the same functions (packages/core/inbox-push-vectors.ts), so there is one
 * implementation of what a push contains.
 *
 * The summary is sealed under the phone's device key: the relay and Apple see the generic alert
 * only, so every field here is for the phone's notification extension alone. Version 2 is
 * additive to version 1 (`v` stays 1): `kind`, `badge`, `time_sensitive` and `actions` are new
 * keys. An app that knows only version 1 reads the same `question` and opens the thread for the rest.
 */
import { INBOX_PERMISSION_AUTO, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL } from "./inbox-permission";

/** Apple's ceiling on a push body. */
export const APNS_BODY_LIMIT = 4096;

/** The body the relay sends to APNs around an envelope, byte for byte as apps/relay/src/apns.ts writes it: a push is sized against it. */
export function apnsBody(envelope: string): string {
  return JSON.stringify({ aps: { alert: { title: "Plannotator", body: "New in your Inbox" }, "mutable-content": 1, sound: "default" }, e: envelope });
}

/**
 * Why a push was sent. `run_ended` is named for the phone's types but not sent yet (a started
 * agent's run ending notifies nowhere today).
 */
export type InboxPushKind = "question" | "review" | "new_thread" | "permission" | "turn_error" | "run_ended" | "replaced";

/** One button the lock screen may offer: `choice.<n>` answers `question.choices[n]` with one Send. */
export interface InboxPushAction {
  id: string;
  /** Dropped first when the push is too large: the phone reads it from `question.choices[n]`. */
  label?: string;
}

export interface InboxPushQuestion {
  key: string;
  revision: number;
  prompt: string;
  context: string | null;
  choices: { label: string; recommended: boolean }[];
}

/** The push summary a phone decrypts. */
export interface InboxPushPlaintext {
  v: 1;
  /** Pushes and down items share the device key: the reader checks the type, so a relay cannot pass one off as the other. */
  type: "push";
  thread_id: string;
  message_id: string;
  subject?: string;
  project?: string;
  agent?: string;
  /** Present only for exactly one open single-choice question with 1 to 4 choices one tap can answer; null otherwise. */
  question?: InboxPushQuestion | null;
  kind?: InboxPushKind;
  /** The rows that wait on the person now (the app's badge). */
  badge?: number;
  /** The thread holds up work: the agent stopped on the person, a `Holds up:` line, or a permission prompt. */
  time_sensitive?: boolean;
  /** Beside `question` only: recommended first, each naming its choice by index. */
  actions?: InboxPushAction[];
  /**
   * Spaces that bring the sealed text to a fixed size (`inboxPushSealText`), so the envelope's length, which the
   * relay and Apple see, does not follow the length of the words or the rung of the ladder. Ignored by every reader.
   */
  pad?: string;
}

/**
 * The kinds a push 2 Inbox added that a phone in the field before relay 1.1 never got: sent only to a phone
 * that registered its app's topic through relay 1.1 (the native app, which shows them and will have its own
 * notification settings), so a phone already in use keeps exactly the pushes it had.
 */
export const INBOX_PUSH_KINDS_FOR_NEW_APPS: ReadonlySet<InboxPushKind> = new Set<InboxPushKind>(["new_thread", "turn_error", "run_ended"]);

/** One of the message's questions, as much as a push reads (an `InboxQuestion` from the store fits). */
export interface InboxPushInputQuestion {
  key: string;
  revision: number;
  prompt: string;
  context: string | null;
  /** `"single"`, `"multi"`, `"action"`…: only `"single"` is offered on a lock screen. */
  kind: string;
  /** Only `"open"` is offered. */
  state: string;
  choices: readonly { label: string; recommended: boolean }[];
}

/** What the Inbox knows about one agent message, resolved from its store. */
export interface InboxPushInput {
  thread_id: string;
  message_id: string;
  /** The thread's subject as the list shows it. */
  subject: string;
  project: string;
  agent: string;
  /** The message's questions, in order (any state; only an open one is ever offered). */
  questions: readonly InboxPushInputQuestion[];
  /** A launched session's permission prompt (its author is a `perm:` session). */
  permission?: boolean;
  /** A launched session's failed turn, not yet resolved. */
  turn_error?: boolean;
  /** A guided review. */
  review?: boolean;
  /** It withdrew earlier questions. */
  replaces?: boolean;
  /** It starts a thread an agent began (not the person), not yet resolved. */
  new_thread?: boolean;
  /** The rows that wait on the person now, snoozed and archived rows left out. */
  badge: number;
  /** The thread's row is in Stopped on you or Holding. */
  holds_up?: boolean;
}

/** A permission prompt's choices one tap cannot answer from a lock screen: a mode switch (Full asks to confirm first) and the hand-off to Terminal. */
const NOT_ONE_TAP = new Set<string>([INBOX_PERMISSION_AUTO, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL]);
/** Apple shows at most four actions on a notification. */
const ACTIONS_MAX = 4;

/**
 * Why this message pushes, or null when it pushes nothing (plain news in an existing thread).
 * One message pushes once, under the first that applies: permission, turn_error, review,
 * question, replaced, new_thread.
 */
export function inboxPushKind(input: InboxPushInput): InboxPushKind | null {
  if (input.permission && input.questions.length > 0) return "permission";
  if (input.turn_error) return "turn_error";
  if (input.review) return "review";
  if (input.questions.length > 0) return "question";
  if (input.replaces) return "replaced";
  if (input.new_thread) return "new_thread";
  return null;
}

/**
 * The summary for one agent message, or null when it pushes nothing. The caller leaves out a
 * person's message and any message in a thread snoozed now before calling.
 */
export function inboxPushPlaintext(input: InboxPushInput): InboxPushPlaintext | null {
  const kind = inboxPushKind(input);
  if (!kind) return null;
  // Only an open question is ever offered for a lock-screen answer (an action item, `kind: "action"`, has no lock-screen Done).
  const open = input.questions.filter((q) => q.state === "open" && q.kind !== "action");
  const only = open.length === 1 && open[0]!.kind === "single" ? open[0]! : null;
  // A permission prompt offers only what one tap can answer; any other question offers all its choices.
  const offered = only ? (kind === "permission" ? only.choices.filter((choice) => !NOT_ONE_TAP.has(choice.label)) : only.choices) : [];
  const question: InboxPushQuestion | null =
    only && offered.length > 0 && offered.length <= ACTIONS_MAX
      ? {
          key: only.key,
          revision: only.revision,
          prompt: only.prompt,
          context: only.context || null,
          choices: offered.map((choice) => ({ label: choice.label, recommended: choice.recommended })),
        }
      : null;
  // Drawn recommended first; each names its choice by index, whatever the order.
  const actions = question
    ? question.choices
        .map((choice, index) => ({ id: `choice.${index}`, label: choice.label, recommended: choice.recommended }))
        .sort((a, b) => Number(b.recommended) - Number(a.recommended))
        .map(({ id, label }) => ({ id, label }))
    : [];
  return {
    v: 1,
    type: "push",
    thread_id: input.thread_id,
    message_id: input.message_id,
    subject: input.subject,
    project: input.project,
    agent: input.agent,
    question,
    kind,
    badge: input.badge,
    time_sensitive: kind === "permission" || input.holds_up === true,
    ...(actions.length > 0 ? { actions } : {}),
  };
}

/**
 * The size ladder as data: each smaller summary to try, in order, when the one before does not
 * fit Apple's 4096 bytes. The actions without their labels; then without `question.context`;
 * then without the question (and so without actions); last, always, the ids with the kind, the
 * badge and `time_sensitive` alone. A rung that would change nothing is left out.
 */
export function inboxPushFallbacks(plain: InboxPushPlaintext): InboxPushPlaintext[] {
  const { v, type, thread_id, message_id, kind, badge, time_sensitive } = plain;
  const steps: InboxPushPlaintext[] = [];
  let step = plain;
  if (step.actions?.some((action) => action.label !== undefined)) steps.push((step = { ...step, actions: step.actions.map(({ id }) => ({ id })) }));
  if (step.question?.context) steps.push((step = { ...step, question: { ...step.question, context: null } }));
  if (step.question) {
    const { actions: _dropped, ...rest } = step;
    steps.push((step = { ...rest, question: null }));
  }
  steps.push({ v, type, thread_id, message_id, ...(kind ? { kind } : {}), ...(badge !== undefined ? { badge } : {}), ...(time_sensitive !== undefined ? { time_sensitive } : {}) });
  return steps;
}

/** The size steps a sealed push text is padded to, in UTF-8 bytes; the last step is the largest text that fits. */
export const INBOX_PUSH_PAD_STEP = 512;

/** The largest sealed text, in UTF-8 bytes, whose envelope (12-byte IV + text + 16-byte tag, base64url without `=`) fits Apple's ceiling in the APNs body. */
export const INBOX_PUSH_TEXT_MAX = Math.floor(((APNS_BODY_LIMIT - apnsBody("").length) * 3) / 4) - 28;

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * The text to seal for this summary: its JSON with `pad` added so the text is a whole number of
 * `INBOX_PUSH_PAD_STEP` bytes (or exactly `INBOX_PUSH_TEXT_MAX` above the last whole step), or null when the
 * summary cannot fit at all (the caller tries the next rung of `inboxPushFallbacks`).
 */
export function inboxPushSealText(plain: InboxPushPlaintext): string | null {
  const { pad: _old, ...rest } = plain;
  const bare = utf8Length(JSON.stringify({ ...rest, pad: "" }));
  if (bare > INBOX_PUSH_TEXT_MAX) return null;
  const target = Math.min(Math.ceil(bare / INBOX_PUSH_PAD_STEP) * INBOX_PUSH_PAD_STEP, INBOX_PUSH_TEXT_MAX);
  return JSON.stringify({ ...rest, pad: " ".repeat(target - bare) });
}

/** True when the APNs body around this envelope fits Apple's ceiling. */
export function inboxPushFits(envelope: string): boolean {
  return new TextEncoder().encode(apnsBody(envelope)).length <= APNS_BODY_LIMIT;
}

/**
 * The push's collapse id: HMAC-SHA256 of the thread id under the phone's collapse key
 * (base64url, its own HKDF label, never the envelope key), as lowercase hex. A thread's newer
 * push replaces its older one and the relay never learns the thread.
 */
export async function inboxPushCollapseId(collapseKey: string, threadId: string): Promise<string> {
  const raw = Uint8Array.from(atob(collapseKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(threadId)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}
