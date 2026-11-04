/**
 * Launch: a launched Codex thread's own questions answered in its Inbox
 * thread, on the Inbox's ordinary question cards. Its approvals are
 * inbox-launch-codex-permission.ts; this is the rest of what Codex asks the
 * person (codex-rs 0.165, app-server-protocol `common.rs` server requests):
 *
 *   item/tool/requestUserInput      the model's own question (`request_user_input`, 1 to 3 questions)
 *   mcpServer/elicitation/request   an MCP server's form (MCP `elicitation/create`)
 *
 * Each becomes ONE message from `{ codex, perm:ask:<thread id>, "Codex" }`
 * holding one `:::question` block per question (per form field), keyed by the
 * request so a request Codex sends again (after a dropped connection or an
 * Inbox restart, on `thread/resume`) is the same card. The `perm:` identity
 * keeps what a permission prompt has (the answer is never a second turn, the
 * person's own words still go to Codex, it is never asked again) while the
 * window draws a plain question card.
 *
 * The answer goes back as the request's result once every question of the
 * card is sent (or skipped), in the shape Codex's own TUI sends:
 *  - requestUserInput: `{ answers: { <question id>: { answers: [...] } } }`, the picked option's label as
 *    Codex wrote it; the card's "Other…" text (or a free-text question's text) as the person's own words; a
 *    note after them; a skipped question with no answers.
 *  - elicitation: `accept` with `content` (an enum's value, a string's text, a boolean), or `cancel` when the
 *    person skipped every field or one Codex requires (its TUI cannot send a form missing one; Esc cancels).
 * The reply that carried the answer is marked delivered to the card's identity only once it went, and the
 * answer of every other card it answered too (one Send answers all of a thread's open cards). The
 * person's words are never dropped: "Other…" text on a question that takes none (no `isOther`, a form's
 * choice) answers it as skipped, and a note on a form has no place in it, so that reply goes on to the thread
 * itself (`InboxStore.forwardAskReply`) and the Inbox's wake delivers it as the next turn, like any reply.
 * Marking the thread read never answers: the store leaves these cards open (Mark read), and a question
 * closed unanswered (the thread archived) keeps Codex waiting, as Terminal does.
 *
 * Asked only when the card shows it whole and exactly (the body read back is
 * the questions as written; a spaced dash inside a choice's label gets a word
 * joiner so the block keeps the label whole); never: a secret question (the Inbox would keep
 * the answer), a number or a multi-select field, a form with no field (an
 * approval: `_meta.codex_approval_kind`, or a message-only form; an MCP tool
 * call's approval is the permission card's), the URL and
 * OpenAI form modes. Those wait on Terminal (`codex resume`), as an approval
 * the card cannot show does.
 *
 * Waiting mirrors Codex: it waits for the answer for as long as the turn
 * runs, except a requestUserInput that is not blocking (`isBlocking: false`),
 * which Codex's TUI resolves with no answers after 120 s unless the person
 * touched it; here, unless a question of the card is picked or sent.
 *
 * Gone: Codex settled it without the Inbox (`serverRequest/resolved`: answered
 * in Terminal), the turn ended (or Stop, Delete), the thread is not loaded in
 * Codex any more (its daemon stopped: the host's own read says `absent`), or
 * after an Inbox restart no request came back for an open card while the
 * thread is not waiting on the person: the card is withdrawn as a permission
 * prompt's is ("Answered in Terminal." / "No longer waiting.", the card reads
 * "No longer applies"). An answer the person sent that never reached Codex is
 * never left looking delivered: its reply stays undelivered and one note from
 * the card's identity says so (`CODEX_ASK_NOT_TAKEN`).
 */

import { createHash } from "node:crypto";
import { INBOX_PERMISSION_ANSWERED_IN_TERMINAL, INBOX_PERMISSION_ASK_IN_TERMINAL, INBOX_PERMISSION_NO_LONGER_WAITING, inboxAskSession, isInboxAskSession } from "@plannotator/core/inbox-permission";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { INBOX_CODEX_NAME, type InboxMessage, type InboxQuestion } from "@plannotator/core/inbox-types";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import type { LaunchPermissionContext } from "./inbox-launch-host";
import { isCodexToolApproval } from "./inbox-launch-codex-permission";
import { createLaunchQuestions } from "./inbox-launch-permission";
import type { CodexThreadStatus } from "./inbox-launch-codex";

export const CODEX_USER_INPUT = "item/tool/requestUserInput";
export const CODEX_ELICITATION = "mcpServer/elicitation/request";

/**
 * Codex's TUI resolves a requestUserInput that is not blocking with no answers after 60 s unseen and a 60 s
 * countdown (tui request_user_input `AUTO_RESOLUTION_HIDDEN_GRACE` + `AUTO_RESOLUTION_VISIBLE_COUNTDOWN`), unless
 * the person touched it. A blocking one (the default) waits.
 */
export const CODEX_USER_INPUT_AUTO_RESOLVE_MS = 120_000;

/** An open card with no request behind it this long after connecting (an Inbox restart, the request gone): no longer waiting. */
const ADOPT_MS = 5_000;
/** A request Codex settled without our answer: what settled it is read this long after (a turn that ended says so). */
const RESOLVED_SETTLE_MS = 1_000;

// ── Words waiting on the owner's OK (/tmp/codex-questions/WORDS.md). Placeholders: they do not ship as they are. ──

/** WORDS.md W1, PENDING the owner's OK: the note when an answer the person sent never reached Codex. */
export const CODEX_ASK_NOT_TAKEN = "[WORDS.md W1: pending the owner's OK]";
/** WORDS.md W2, PENDING the owner's OK: a boolean form field's two choices (Codex's TUI says "True" / "False"). */
export const CODEX_BOOLEAN_TRUE = "[WORDS.md W2: true]";
export const CODEX_BOOLEAN_FALSE = "[WORDS.md W2: false]";

// ── The mapping (pure) ──

/** One question of a card: one requestUserInput question, or one form field. */
export interface CodexAskField {
  /** The question's id (requestUserInput) or the field's name (elicitation): the result's key. */
  id: string;
  kind: "single" | "text";
  prompt: string;
  /** The choices in card order: the label the card shows and the value an answer of it sends. */
  choices: { label: string; value: string | boolean }[];
  /** An elicitation field Codex requires (its TUI cannot send the form without it). */
  required: boolean;
  /** The answer carries the person's own words besides a pick (a requestUserInput question with `isOther`); else Other is not Codex's to take. */
  other: boolean;
  /** The answer carries the person's note (requestUserInput); a form has no place for one. */
  notes: boolean;
}

/** A Codex request as a card: its body and its questions, in block order. */
export interface CodexAsk {
  method: typeof CODEX_USER_INPUT | typeof CODEX_ELICITATION;
  body: string;
  fields: CodexAskField[];
  /** False only for a requestUserInput Codex marks not blocking (it resolves by itself). */
  blocking: boolean;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
/** One line: every run of whitespace (line breaks too) one space, at most `max` characters. */
const oneLine = (value: string, max = 500): string => value.replace(/\s+/g, " ").trim().slice(0, max);
/**
 * A choice's label, kept whole on the card: the block format splits a choice at its first spaced dash
 * (`label — description`), so a dash inside the label gets an invisible word joiner (U+2060) before it, which
 * the split does not take. The answer still sends Codex's own label (the card's label is read by position).
 */
const choiceLabel = (value: string): string => oneLine(value, 200).replace(/(\s)([—–-])(?=\s)/g, "$1\u2060$2");

/**
 * The card for one request, or null when the card cannot show it whole and exactly. The body is read back as
 * the Inbox reads it: exactly these questions, kinds, prompts and choices, and nothing else that acts (no
 * `Replaces:`, `Stopped:` or `Holds up:` line from the request's text), or it is not asked.
 */
export function codexAskOf(method: string, params: Record<string, any>): CodexAsk | null {
  const built = method === CODEX_USER_INPUT ? userInputCard(params) : method === CODEX_ELICITATION ? elicitationCard(params) : null;
  if (!built || built.fields.length === 0) return null;
  const read = parseInboxQuestionBlocks(built.body);
  if (read.length !== built.fields.length) return null;
  const exact = read.every((q, i) => {
    const field = built.fields[i]!;
    if (q.kind !== field.kind || q.prompt !== field.prompt || q.replaces.length > 0 || q.stopped !== null || q.holds_up.length > 0) return false;
    if (q.parsed.choices.length !== field.choices.length) return false;
    // A choice's label as the card keeps it, or as written (a `(Recommended)` marker leaves the label, as Codex's own models write it).
    return q.parsed.choices.every((c, j) => c.label === field.choices[j]!.label || (q.parsed.aliases[j] ?? []).includes(field.choices[j]!.label));
  });
  if (!exact) return null;
  // The labels as the card keeps them, which the person's pick names.
  const fields = built.fields.map((field, i) => ({ ...field, choices: field.choices.map((c, j) => ({ ...c, label: read[i]!.parsed.choices[j]!.label })) }));
  return { ...built, fields };
}

function block(kind: "single" | "text", prompt: string, context: string | null, choices: { label: string; description?: string | null }[]): string {
  const lines = [kind === "text" ? ":::question-text" : ":::question", prompt, ""];
  if (context) lines.push(context, "");
  for (const c of choices) lines.push(`- [ ] ${c.label}${c.description ? ` — ${c.description}` : ""}`);
  lines.push(":::");
  return lines.join("\n");
}

/** `request_user_input`: each question a block (its header over it), options as choices, none as free text. */
function userInputCard(params: Record<string, any>): Omit<CodexAsk, "fields"> & { fields: CodexAskField[] } | null {
  const questions = Array.isArray(params.questions) ? (params.questions as Record<string, any>[]) : [];
  if (questions.length === 0) return null;
  const parts: string[] = [];
  const fields: CodexAskField[] = [];
  for (const q of questions) {
    // A secret's answer would be kept in the Inbox's log and shown on every device: Terminal only.
    if (!q || typeof q.id !== "string" || !text(q.question) || q.isSecret === true) return null;
    const options = Array.isArray(q.options) ? (q.options as Record<string, any>[]) : [];
    if (options.some((o) => !o || !text(o.label))) return null;
    const prompt = oneLine(q.question);
    const header = text(q.header) ? oneLine(q.header, 100) : null;
    const choices = options.map((o) => ({ label: choiceLabel(o.label), description: text(o.description) ? oneLine(o.description) : null }));
    if (header && header !== prompt) parts.push(`**${header}**`, "");
    parts.push(block(choices.length > 0 ? "single" : "text", prompt, null, choices), "");
    // The value an answer sends is Codex's own label, as its TUI sends it.
    fields.push({
      id: q.id,
      kind: choices.length > 0 ? "single" : "text",
      prompt,
      choices: choices.map((c, i) => ({ label: c.label, value: options[i]!.label as string })),
      required: false,
      other: choices.length === 0 || q.isOther === true,
      notes: true,
    });
  }
  return { method: CODEX_USER_INPUT, body: parts.join("\n").trim(), fields, blocking: params.isBlocking !== false };
}

/** An MCP form (`mode: "form"`) whose every field is a string, a single-select enum or a boolean, as Codex's TUI asks it. */
function elicitationCard(params: Record<string, any>): (Omit<CodexAsk, "fields"> & { fields: CodexAskField[] }) | null {
  if (params.mode !== "form") return null;
  const meta = params._meta;
  // Codex's own approvals ride elicitation (an MCP tool call, a tool suggestion, browser auth): not a question.
  if (meta && typeof meta === "object" && (meta.codex_approval_kind !== undefined || meta.codex_requires_user_input !== undefined)) return null;
  const schema = params.requestedSchema;
  if (!schema || typeof schema !== "object" || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") return null;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((r): r is string => typeof r === "string") : []);
  const parts: string[] = [];
  const message = text(params.message);
  if (message) parts.push(message.trim(), "");
  const fields: CodexAskField[] = [];
  for (const [id, raw] of Object.entries(schema.properties as Record<string, any>)) {
    const field = elicitationField(id, raw, required.has(id));
    if (!field) return null;
    parts.push(block(field.kind, field.prompt, field.context, field.choices), "");
    fields.push({ id, kind: field.kind, prompt: field.prompt, choices: field.choices.map((c) => ({ label: c.label, value: c.value })), required: field.required, other: field.kind === "text", notes: false });
  }
  return { method: CODEX_ELICITATION, body: parts.join("\n").trim(), fields, blocking: true };
}

function elicitationField(id: string, raw: any, required: boolean): (Omit<CodexAskField, "other" | "notes"> & { context: string | null }) | null {
  if (!raw || typeof raw !== "object") return null;
  const title = text(raw.title) ? oneLine(raw.title, 200) : oneLine(id, 200);
  const description = text(raw.description) ? oneLine(raw.description) : null;
  const base = { id, prompt: title, context: description && description !== title ? description : null, required };
  if (raw.type === "boolean") {
    return { ...base, kind: "single", choices: [{ label: CODEX_BOOLEAN_TRUE, value: true }, { label: CODEX_BOOLEAN_FALSE, value: false }] };
  }
  if (raw.type !== "string") return null; // number, integer, array (multi-select): Codex's TUI does not ask them either
  if (Array.isArray(raw.oneOf)) {
    const options = raw.oneOf as Record<string, any>[];
    if (options.length === 0 || options.some((o) => !o || typeof o.const !== "string" || !text(o.title))) return null;
    return { ...base, kind: "single", choices: options.map((o) => ({ label: choiceLabel(o.title), value: o.const as string })) };
  }
  if (Array.isArray(raw.enum)) {
    const values = raw.enum as unknown[];
    const names = Array.isArray(raw.enumNames) ? (raw.enumNames as unknown[]) : [];
    if (values.length === 0 || values.some((v) => typeof v !== "string" || !v.trim())) return null;
    return { ...base, kind: "single", choices: values.map((v, i) => ({ label: choiceLabel(text(names[i]) ?? (v as string)), value: v as string })) };
  }
  return { ...base, kind: "text", choices: [] };
}

/**
 * The person's answer to one field: the picked choice's value, their own words, a note; or nothing (skipped).
 * `forward`: they wrote words Codex's answer has no place for (Other on a question without it, a note on a
 * form). Those are never dropped: their reply goes on to the thread as its next turn. Other where Codex takes
 * none answers the field as skipped.
 */
export interface CodexFieldAnswer {
  value: string | boolean | null;
  words: string | null;
  note: string | null;
  forward: boolean;
}

/** One card question's answer as the field reads it: the pick matched by the label the card keeps, never by position alone. */
export function codexFieldAnswer(field: CodexAskField, question: Pick<InboxQuestion, "state" | "answer" | "choices">): CodexFieldAnswer {
  const answer: QuestionAnswer | null = question.state === "sent" ? question.answer : null;
  if (!answer || answer.skipped) return { value: null, words: null, note: null, forward: false };
  const rawNote = answer.note?.trim() || null;
  const note = field.notes ? rawNote : null;
  const forwardNote = !!rawNote && !field.notes;
  if (field.kind === "text") return { value: null, words: answer.text?.trim() || answer.other?.trim() || null, note, forward: forwardNote };
  const other = answer.other?.trim() || null;
  // Words Codex takes none of: the field is skipped, and the words go on as a turn.
  if (other && !field.other) return { value: null, words: null, note: null, forward: true };
  const picked = answer.selected.length === 1 ? question.choices.findIndex((c) => c.label === answer.selected[0]) : -1;
  return { value: picked >= 0 && field.choices[picked] ? field.choices[picked]!.value : null, words: other, note, forward: forwardNote };
}

/** requestUserInput's result: per question, the picked label, else the person's words, then a note; a skip answers nothing. */
export function codexUserInputResult(ask: CodexAsk, answers: readonly CodexFieldAnswer[]): { answers: Record<string, { answers: string[] }> } {
  const out: Record<string, { answers: string[] }> = {};
  ask.fields.forEach((field, i) => {
    const a = answers[i] ?? { value: null, words: null, note: null, forward: false };
    const list: string[] = [];
    if (typeof a.value === "string") list.push(a.value);
    if (a.words) list.push(a.words);
    if (a.note) list.push(a.note);
    out[field.id] = { answers: list };
  });
  return { answers: out };
}

/** An elicitation's result: `accept` with each answered field, or `cancel` when nothing was answered or a required field was not. */
export function codexElicitationResult(ask: CodexAsk, answers: readonly CodexFieldAnswer[]): { action: "accept" | "cancel"; content: Record<string, string | boolean> | null; _meta: null } {
  const content: Record<string, string | boolean> = {};
  ask.fields.forEach((field, i) => {
    const a = answers[i];
    if (!a) return;
    if (field.kind === "text" && a.words) content[field.id] = a.words;
    else if (field.kind === "single" && a.value !== null) content[field.id] = a.value;
  });
  const missing = ask.fields.some((f) => f.required && !(f.id in content));
  if (Object.keys(content).length === 0 || missing) return { action: "cancel", content: null, _meta: null };
  return { action: "accept", content, _meta: null };
}

/**
 * The card's key for one request: requestUserInput by its item (the tool call), an elicitation by its request
 * id (Codex sends a pending request again with the same id) and what it asks. The store's idempotency key is
 * `perm-<key>`.
 */
export function codexAskKey(method: string, params: Record<string, any>, rpcId: number | string): string {
  const whole =
    method === CODEX_USER_INPUT
      ? JSON.stringify([method, params.threadId, params.itemId ?? null])
      : JSON.stringify([method, params.threadId, params.turnId ?? null, rpcId, params.serverName ?? null, params.message ?? null, params.requestedSchema ?? null]);
  return `codex-ask-${createHash("sha256").update(whole).digest("hex")}`;
}

// ── The transport ──

interface Pending {
  key: string;
  threadId: string;
  /** The JSON-RPC id to answer on the connection now; null once the connection dropped (until Codex sends it again). */
  rpcId: number | string | null;
  method: string;
  ask: CodexAsk | null;
  messageId: string | null;
  /** When the card was first asked (its message's time): a request that is not blocking resolves from then. */
  askedAt: number;
  answered: boolean;
  /** Codex settled it without our answer at this time; what settled it is said on a later sweep. */
  resolvedAt: number | null;
}

export function createCodexQuestions(
  options: LaunchPermissionContext & {
    /** Answer the request on the connection now; false when it could not go (no connection). */
    respond: (id: number | string, result: unknown) => boolean;
    /** A thread's status as this connection last saw it; null while not connected. */
    status: (threadId: string) => CodexThreadStatus | null;
    /** When the connection opened; null while not connected. */
    connectedAt: () => number | null;
  },
) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const pending = new Map<string, Pending>();
  const byRpc = new Map<string, string>();
  const questions = createLaunchQuestions({ store, name: INBOX_CODEX_NAME, displayFolder: options.displayFolder, onChange: options.onChange, log });

  const rootOfThread = (threadId: string): InboxMessage | null => options.roots().find((root) => root.launch!.session_ref === threadId) ?? null;
  const drop = (p: Pending) => {
    pending.delete(p.key);
    if (p.rpcId !== null) byRpc.delete(String(p.rpcId));
  };
  /** A reply gone on to the Codex thread itself (`forwardAskReply`): the thread's wake delivers it. */
  const forwarded = (reply: InboxMessage) => !!reply.to && !isInboxAskSession(reply.to.session);
  /**
   * The card's questions answered and sent whose answer never reached Codex: Codex did not take this card's answer
   * with the reply that sent it (`ask_taken`). A reply gone on to the thread carries no answer of a card not taken.
   */
  const undelivered = (messageId: string): InboxQuestion[] =>
    store.questionsOf(messageId).filter((q) => {
      const reply = q.state === "sent" && q.sent_reply_id ? store.message(q.sent_reply_id) : undefined;
      return !!reply && !(reply.ask_taken ?? []).includes(messageId);
    });

  const notTakenKey = (messageId: string) => `perm-not-taken-${messageId}`;
  /** The card's note that an answer never reached Codex is there. */
  const saidNotTaken = (messageId: string): boolean => {
    const card = store.message(messageId);
    return !!card && store.threadMessageIds(card.thread_id).some((id) => store.message(id)?.idempotency_key === notTakenKey(messageId));
  };
  /** An answer of the card that never reached Codex, not yet said. */
  const notTakenDue = (messageId: string): boolean => undelivered(messageId).length > 0 && !saidNotTaken(messageId);
  /** The card went (withdrawn, or said not taken): no answer of it goes to Codex any more, from the store, so across a restart too. */
  const cardGone = (messageId: string): boolean => store.questionsOf(messageId).some((q) => q.state === "superseded") || saidNotTaken(messageId);

  /** The card goes: its open questions withdrawn, and an answer sent that never reached Codex said so, once. */
  const gone = (messageId: string, why: string) => {
    questions.withdraw(messageId, why);
    if (notTakenDue(messageId)) sayNotTaken(messageId);
  };

  /** One note under the card from its identity: an answer sent on it never reached Codex. */
  const sayNotTaken = (messageId: string) => {
    const card = store.message(messageId);
    if (card?.author.kind !== "agent" || saidNotTaken(messageId)) return;
    try {
      store.sendMessage({ project_id: card.project_id, author: card.author, permission: true, body: CODEX_ASK_NOT_TAKEN, reply_to: messageId, idempotency_key: notTakenKey(messageId) });
      log(`Inbox launch: an answer to Codex question ${messageId} never reached Codex`);
    } catch (error) {
      log(`Inbox launch: could not say ${messageId}'s answer was not taken: ${error instanceof Error ? error.message : String(error)}`);
    }
    options.onChange();
  };

  /** The card for a request, written once per key (a request sent again is its card from before, an earlier Inbox run's too). */
  const askCard = (root: InboxMessage, threadId: string, key: string, ask: CodexAsk): string => {
    const idempotency = `perm-${key}`;
    for (const id of store.threadMessageIds(root.thread_id)) {
      const earlier = store.message(id);
      if (earlier?.idempotency_key === idempotency && earlier.author.kind === "agent" && isInboxAskSession(earlier.author.session)) return earlier.id;
    }
    const latest = store.threadMessageIds(root.thread_id).at(-1) ?? root.id;
    const sent = store.sendMessage({
      project_id: root.project_id,
      author: { kind: "agent", host: root.launch!.agent, session: inboxAskSession(threadId), name: INBOX_CODEX_NAME },
      permission: true,
      body: ask.body,
      reply_to: latest,
      idempotency_key: idempotency,
    });
    if (!sent.replayed) {
      log(`Inbox launch ${root.launch!.id}: Codex question ${sent.message.id} (${ask.method}, ${ask.fields.length})`);
      // Codex is blocked on this answer, so a snoozed thread wakes at once (as for a permission prompt).
      store.endSnooze(root.thread_id);
    }
    options.onChange();
    return sent.message.id;
  };

  /**
   * The request's result once the person answered or skipped every question of the card (sent); null while one
   * is still open, picked or closed. A question closed unanswered (the thread archived) never answers for the
   * person: Codex waits, as it does in Terminal. `forward`: the replies whose words the result has no place for.
   */
  const resultOf = (p: Pending): { result: unknown; forward: Map<string, string[]> } | null => {
    const qs = store.questionsOf(p.messageId!);
    if (qs.length !== p.ask!.fields.length || qs.some((q) => q.state !== "sent")) return null;
    const answers = p.ask!.fields.map((field, i) => codexFieldAnswer(field, qs[i]!));
    // Per reply, the questions whose words the result has no place for.
    const forward = new Map<string, string[]>();
    qs.forEach((q, i) => {
      if (answers[i]!.forward && q.sent_reply_id) forward.set(q.sent_reply_id, [...(forward.get(q.sent_reply_id) ?? []), q.key]);
    });
    return { result: p.method === CODEX_USER_INPUT ? codexUserInputResult(p.ask!, answers) : codexElicitationResult(p.ask!, answers), forward };
  };

  /** A reply that carries something besides its answers (its own words, feedback, files): Codex's answer has no place for it. */
  const carriesMore = (reply: InboxMessage | null | undefined): boolean => !!reply && (!!reply.ask_words || (reply.attachments?.length ?? 0) > 0);

  /** The replies that sent answers on a card. */
  const repliesOf = (cardId: string): string[] => [...new Set(store.questionsOf(cardId).map((q) => q.sent_reply_id).filter((id): id is string => !!id))];

  /** The Codex question cards a reply sent answers on (one Send answers every card of the thread's Codex questions at once). */
  const cardsAnswered = (reply: InboxMessage): string[] =>
    store.threadMessageIds(reply.thread_id).filter((id) => {
      const m = store.message(id);
      return m?.author.kind === "agent" && isInboxAskSession(m.author.session) && store.questionsOf(id).some((q) => q.sent_reply_id === reply.id);
    });

  /**
   * A reply is settled once every card it answered had its answer taken by Codex (`ask_taken`) or went (`cardGone`,
   * its note saying the answer was not taken), read from the store so a restart never lets it go early. Then,
   * when it holds words Codex's answers had no place for (`ask_forward`, from any of its cards) or words of its
   * own, it goes on to the thread itself as its next turn, carrying just those; otherwise it is delivered to the
   * cards' identity when Codex took some answer of it, and left undelivered when none. Never before: one Send can
   * answer two cards that Codex takes one at a time. A reply that answers no question (words, feedback or files
   * alone) never answers Codex's request, so it goes on at once.
   */
  const settle = (replyId: string, threadId: string) => {
    const reply = store.message(replyId);
    if (!reply || reply.author.kind !== "person" || reply.delivery || forwarded(reply)) return;
    const asked = reply.reply_to ? store.message(reply.reply_to) : null;
    if (asked?.author.kind !== "agent" || !asked.author.host || !isInboxAskSession(asked.author.session)) return;
    const cards = cardsAnswered(reply);
    const taken = reply.ask_taken ?? [];
    if (cards.some((id) => !taken.includes(id) && !cardGone(id))) return;
    const forward = (reply.ask_forward?.length ?? 0) > 0 || carriesMore(reply);
    // No words to carry and no answer Codex took: nothing reached Codex (the card's note says so).
    if (!forward && taken.length === 0) return;
    try {
      if (forward) {
        store.forwardAskReply(replyId, { host: asked.author.host, session: threadId });
        log(`Inbox launch: reply ${replyId} goes on to Codex as a turn (words its answer could not carry)`);
      } else {
        store.recordDelivery(replyId, { host: asked.author.host, session: asked.author.session! });
      }
      options.onChange();
    } catch {
      // Already delivered or gone on: the answer stands.
    }
  };

  /**
   * The answer to a card went to Codex: each reply that carried it records that (and the words the answer had no
   * place for), then is settled if no other card it answered still waits.
   */
  const delivered = (p: Pending, forward: ReadonlyMap<string, readonly string[]>) => {
    for (const replyId of repliesOf(p.messageId!)) {
      try {
        store.recordAskAnswer(replyId, p.messageId!, forward.get(replyId) ?? []);
      } catch (error) {
        // Settled already. A card Codex took before (sent again after the reply went): its words went with that
        // reply. Otherwise (it never is while a card it answered waits) the words cannot go with it any more, so
        // the card says they were not taken rather than losing them unsaid.
        log(`Inbox launch: could not record ${p.messageId}'s answer on ${replyId}: ${error instanceof Error ? error.message : String(error)}`);
        const took = (store.message(replyId)?.ask_taken ?? []).includes(p.messageId!);
        if (!took && (forward.get(replyId)?.length ?? 0) > 0) sayNotTaken(p.messageId!);
      }
      settle(replyId, p.threadId);
    }
  };

  return {
    /** A server request: true when it is one of these (the card is asked, or left to Terminal). */
    asked(id: number | string, method: string, params: any): boolean {
      if (method !== CODEX_USER_INPUT && method !== CODEX_ELICITATION) return false;
      // An MCP tool call's approval is the permission card's (inbox-launch-codex-permission.ts).
      if (isCodexToolApproval(method, params)) return false;
      if (!params || typeof params.threadId !== "string") return true;
      const root = rootOfThread(params.threadId);
      // Not a launched thread of this Inbox: another client of the daemon answers it.
      if (!root) return true;
      const key = codexAskKey(method, params, id);
      const known = pending.get(key);
      if (known) {
        // Sent again (a dropped connection, `thread/resume`): the same card, answered on this request's id.
        if (known.rpcId !== null) byRpc.delete(String(known.rpcId));
        known.rpcId = id;
        known.answered = false;
        known.resolvedAt = null;
        byRpc.set(String(id), key);
        options.onChange();
        return true;
      }
      const ask = codexAskOf(method, params);
      let messageId: string | null = null;
      let askedAt = now();
      if (ask) {
        const before = store.threadMessageIds(root.thread_id).length;
        messageId = askCard(root, params.threadId, key, ask);
        // A card from before (an earlier Inbox run): Codex's wait started when it was first asked.
        const at = Date.parse(store.message(messageId)?.created_at ?? "");
        if (store.threadMessageIds(root.thread_id).length === before && Number.isFinite(at)) askedAt = Math.min(at, askedAt);
      } else {
        log(`Inbox launch ${root.launch!.id}: a Codex ${method} the card cannot show whole; left to Terminal`);
        // Its card from an earlier Inbox run that no longer reads the same: it cannot be answered here any more.
        for (const mid of store.threadMessageIds(root.thread_id)) {
          const earlier = store.message(mid);
          if (earlier?.idempotency_key === `perm-${key}` && earlier.author.kind === "agent" && isInboxAskSession(earlier.author.session)) gone(earlier.id, INBOX_PERMISSION_ASK_IN_TERMINAL);
        }
      }
      pending.set(key, { key, threadId: params.threadId, rpcId: id, method, ask, messageId, askedAt, answered: false, resolvedAt: null });
      byRpc.set(String(id), key);
      options.onChange();
      return true;
    },

    /** `serverRequest/resolved`: one of ours settled with no answer of ours is said on a later sweep (a turn that ended says so first). */
    resolved(requestId: unknown): void {
      const key = byRpc.get(String(requestId));
      const p = key ? pending.get(key) : undefined;
      if (!p) return;
      if (p.answered || !p.messageId) {
        drop(p);
        return;
      }
      p.resolvedAt ??= now();
    },

    /** The turn ended (or Stop, the thread closed): every card of the thread still open is no longer waited on. */
    turnEnded(threadId: string): void {
      for (const p of [...pending.values()]) {
        if (p.threadId !== threadId) continue;
        drop(p);
        if (!p.answered && p.messageId) gone(p.messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    connectionLost(): void {
      for (const p of pending.values()) p.rpcId = null;
      byRpc.clear();
    },

    /**
     * Every second: answer each card the person finished; resolve a request that is not blocking after Codex's
     * wait; say what settled a request Codex settled without us; after a restart, withdraw an open card no
     * request is behind any more.
     */
    sweep(): void {
      /** The thread is not loaded in Codex (its daemon stopped, or it unloaded): no request of it waits any more. */
      const unloaded = (threadId: string) => options.host.stateOf(threadId) === "absent";
      for (const p of [...pending.values()]) {
        // The connection went and the thread with it (the daemon stopped): the request is gone, never sent again.
        if (p.rpcId === null && unloaded(p.threadId)) {
          drop(p);
          if (!p.answered && p.messageId) gone(p.messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
          continue;
        }
        if (!p.messageId || !p.ask || p.answered) continue;
        if (p.resolvedAt !== null) {
          if (now() - p.resolvedAt < RESOLVED_SETTLE_MS) continue;
          // Settled in Codex while its turn still runs: the person answered in Terminal (`codex resume`).
          drop(p);
          gone(p.messageId, INBOX_PERMISSION_ANSWERED_IN_TERMINAL);
          continue;
        }
        const qs = store.questionsOf(p.messageId);
        // Withdrawn (Stop, Delete), or said not taken: never ours to answer any more.
        if (cardGone(p.messageId)) continue;
        const done = resultOf(p);
        if (done !== null) {
          if (p.rpcId === null || !options.respond(p.rpcId, done.result)) continue;
          p.answered = true;
          delivered(p, done.forward);
          log(`Inbox launch: Codex ${p.method} answered`);
          options.onChange();
          continue;
        }
        // Codex's own wait for a request that is not blocking: no answers, unless the person touched the card.
        const touched = qs.some((q) => q.state !== "open");
        if (!p.ask.blocking && !touched && now() - p.askedAt >= CODEX_USER_INPUT_AUTO_RESOLVE_MS && p.rpcId !== null) {
          if (!options.respond(p.rpcId, { answers: {} })) continue;
          p.answered = true;
          questions.withdraw(p.messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
          log(`Inbox launch: Codex ${p.method} resolved with no answers after Codex's wait`);
        }
      }
      // Every reply to a card not settled yet. One that answers none of the cards' questions (words, feedback or
      // files alone) never answers Codex's request, so it goes on to the thread as a turn now.
      for (const root of options.roots()) {
        const ref = root.launch!.session_ref;
        if (!ref) continue;
        for (const id of store.threadMessageIds(root.thread_id)) {
          const reply = store.message(id);
          if (!reply || reply.author.kind !== "person" || !reply.reply_to || reply.delivery || forwarded(reply)) continue;
          const card = store.message(reply.reply_to);
          if (card?.author.kind !== "agent" || !isInboxAskSession(card.author.session)) continue;
          settle(reply.id, ref);
        }
      }
      const since = options.connectedAt();
      const adopting = since !== null && now() - since >= ADOPT_MS;
      const held = new Set([...pending.values()].map((p) => p.messageId));
      for (const root of options.roots()) {
        const ref = root.launch!.session_ref;
        if (!ref) continue;
        // Not loaded in Codex (the host's own read, connected or not): nothing of it can be asked again.
        if (!unloaded(ref)) {
          if (!adopting) continue;
          const status = options.status(ref);
          // Not read since connecting (nothing known), or waiting on the person: its request may still come again.
          if (!status || (status.type === "active" && (status.activeFlags?.includes("waitingOnUserInput") || status.activeFlags?.includes("waitingOnApproval")))) continue;
        }
        for (const id of store.threadMessageIds(root.thread_id)) {
          const message = store.message(id);
          if (!message || held.has(id) || message.author.kind !== "agent" || !isInboxAskSession(message.author.session)) continue;
          const qs = store.questionsOf(id);
          if (qs.some((q) => q.state === "open" || q.state === "picked") || notTakenDue(id)) gone(id, INBOX_PERMISSION_NO_LONGER_WAITING);
        }
      }
    },

    /** Stop, Delete, launch off: the launch's cards go (their open questions withdrawn, an answer that never went said so). */
    withdrawAll(root: InboxMessage): void {
      for (const p of [...pending.values()]) {
        if (p.threadId !== root.launch!.session_ref) continue;
        drop(p);
        if (!p.answered && p.messageId) gone(p.messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    forget(launchId: string): void {
      const root = options.roots().find((r) => r.launch!.id === launchId);
      if (!root) return;
      for (const p of [...pending.values()]) if (p.threadId === root.launch!.session_ref) drop(p);
    },
  };
}
