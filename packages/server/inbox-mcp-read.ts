/**
 * read_thread's thread mode as an agent reads it (step 2 of the Inbox MCP
 * size work; .product/drafts/inbox-mcp-size/FINDINGS.md): a window, not the
 * whole thread.
 *
 * - The header: subject, name, who wrote, and every question still waiting
 *   on the person (open or picked) with its key, state, prompt and choices.
 * - The newest `limit` messages (default 6) in full.
 * - The person's earlier messages in full, newest first, while they fit in
 *   INBOX_EARLIER_PERSON_BYTES (12 KB); older ones become one line too.
 * - Every other earlier message as one line: id, author, time, first words,
 *   size, and each of its questions with its state and answer.
 * - Bodies over INBOX_BODY_CUT_BYTES (16 KB) are cut with a marker that
 *   names the `expand` call for the rest.
 *
 * No question state is ever lost: a question is in the header (open or
 * picked), on a message shown in full, on a one-line message, or, for a
 * message `before` / `after` left out, in `thread.questions`.
 *
 * The messages keep the field names of the full records (`id`, `author.kind`,
 * `body`, `questions[].key/state/answer`, `attachments[].path`, `ack`), with
 * the bookkeeping left out (sha256s, mtimes, revisions, idempotency keys,
 * repeated project and thread ids, pickers, inline-image records).
 * `format: "full"` returns the full records as before.
 *
 * The text the result carries is a complete transcript (ids, authors, times,
 * bodies, every question's state and answer), so the result is marked
 * INBOX_TEXT_COMPLETE_META_KEY: a current connection hands the model the
 * text alone; an older one appends this trimmed JSON as well.
 */

import { INBOX_HOST_NAMES, inboxAgentName, inboxBoardRequestBlock, isInboxNote, type InboxMessageWire, type InboxQuestion } from "@plannotator/core/inbox-types";
import { inboxAnswersSectionEnd } from "@plannotator/core/inbox-questions";
import { QUESTION_ANSWERS_HEADING, type QuestionAnswer } from "@plannotator/core/question-block";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { inboxSearchBodyText, inboxSearchReplyText } from "@plannotator/shared/inbox/search";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** Messages read_thread shows in full by default: the newest six. */
export const INBOX_THREAD_WINDOW = 6;
/** A body longer than this is cut, with a marker naming the `expand` call. */
export const INBOX_BODY_CUT_BYTES = 16 * 1024;
/**
 * The person's earlier messages (before the window) shown in full, newest
 * first, while their bodies total at most this; older ones become one line.
 * 12 KB holds every person message of the longest thread measured (17
 * replies, about 12 KB of their words in a 46-message thread), while a
 * thread of hundreds of rounds still costs a bounded 3k tokens for them.
 * The person's words are what agents re-read most (9 of 11 hand parses of a
 * thread selected them); an agent's own earlier messages are one `expand`
 * away.
 */
export const INBOX_EARLIER_PERSON_BYTES = 12 * 1024;
/** First words of a one-line message. */
export const INBOX_LINE_WORDS = 120;
/** At most this many ids in `expand`. */
export const INBOX_EXPAND_MAX = 50;


/** An author as an agent reads it: the person, or an agent by the name the person sees. */
export type AgentAuthor = { kind: "person" } | { kind: "agent"; name: string };

/** A question's answer without the copies of its key, kind and prompt. */
export interface AgentAnswer {
  selected?: string[];
  other?: string;
  text?: string;
  note?: string;
  skipped?: true;
  /** With skipped: the Inbox skipped it because a Send left it unanswered. */
  by_reply?: true;
}

export interface AgentQuestionRef {
  key: string;
  /** Its number in the message, as the reply's "Answers to your questions" numbers it (Q1, Q2, …). */
  q: number;
  state: InboxQuestion["state"];
  answer?: AgentAnswer;
  /** `<message id>/<key>` of the question that replaced it, or `<message id>` when nothing did. */
  superseded_by?: string;
  /**
   * On an action item (`kind: "action"`, key `a-…`, numbered A1, A2…): what came of
   * it, in words: `done`, `done, note: "…"`, `can't do it: "…"`, or `you saw
   * it done` (your own `done`). Absent on a question and while it is open.
   */
  result?: string;
  /**
   * On a one-line message and in `thread.questions`: the prompt, clipped, so
   * an answer ("Yes") says what it answers (the reply's answers section,
   * which named it, is left out of the person's earlier messages).
   */
  prompt?: string;
}

/** A question's prompt on a one-line message: enough to tell what an answer answers. */
export const INBOX_LINE_PROMPT_CHARS = 120;

export interface AgentQuestion extends AgentQuestionRef {
  kind: InboxQuestion["kind"];
  prompt: string;
}

export interface AgentOpenQuestion extends AgentQuestion {
  message_id: string;
  choices: string[];
}

export interface AgentMessage {
  id: string;
  author: AgentAuthor;
  created_at: string;
  reply_to: string | null;
  body: string;
  /** The body is not shown as sent (cut at INBOX_BODY_CUT_BYTES, or an earlier reply without its answers section): its full size in bytes; expand shows it whole. */
  body_bytes?: number;
  questions?: AgentQuestion[];
  attachments?: { name: string; kind: string; size: number; path: string }[];
  ack?: { label: string; at: string };
  guide?: { title: string };
  /** A person's message addressed to one agent session (a New message, or a reply sent to another session because the asker ended); on a reply that tags agents, its owner. */
  to?: AgentAddressee;
  /** On a person's reply that tags agents (approval "inbox-tag-agents"): the sessions it tags, and whether one is the reader (`you`). */
  tagged?: AgentTagged[];
  /**
   * The person sent it with compose's Board chip on (approval
   * "inbox-compose-board-chip"): the agent tracks the work on the Board.
   * `messageText` puts `inboxBoardRequestBlock` after the body; `body` stays
   * the person's words.
   */
  board_request?: true;
  /** With `board_request`: the cards in flight that link this thread already (not shipped, not dropped), for `messageText`. */
  board_cards?: { id: string; title: string }[];
}

/** One agent session a person's reply tags, as an agent reads it. */
export interface AgentTagged {
  agent: string;
  session: string;
  you: boolean;
}

/** Who a person's message is for: the session's host and id, and whether that is the reader (`you`). */
export interface AgentAddressee {
  host: string;
  session: string;
  you: boolean;
}

export interface AgentMessageLine {
  id: string;
  author: AgentAuthor;
  created_at: string;
  reply_to: string | null;
  /** The first words, plain text. */
  words: string;
  /** The body's size in bytes. */
  bytes: number;
  questions?: AgentQuestionRef[];
  attachments?: string[];
  guide?: string;
  ack?: true;
  to?: AgentAddressee;
  tagged?: AgentTagged[];
  board_request?: true;
}

export interface ThreadReadInput {
  limit?: number;
  expand?: string[];
  before?: string | number;
  after?: string | number;
  message_id?: string;
  /** The reader's session: a message addressed to it says `you`. */
  caller?: string | null;
}

export interface ThreadWindowResult {
  thread: {
    thread_id: string;
    subject: string | null;
    thread_name: string | null;
    resolved_at: string | null;
    project: { id: string; name: string; root: string };
    message_count: number;
    participants: { kind: "person" | "agent"; name: string; messages: number }[];
    /** Every question still waiting on the person (open, or picked and not sent). */
    open_questions: AgentOpenQuestion[];
    /** Shown in full, oldest first: the window, the person's earlier messages, and any expanded or asked-for message. */
    messages: AgentMessage[];
    /** Every other message in range, oldest first, one line each. */
    earlier: AgentMessageLine[];
    /** Questions of messages `before` / `after` left out, so no question's state is lost. */
    questions?: (AgentQuestionRef & { message_id: string })[];
  };
  window: {
    limit: number;
    /** Messages shown in full, as one line, and left out by before / after. */
    full: number;
    lines: number;
    left_out: number;
    /** Of `full`: the newest in range, the person's earlier messages, and the ones expanded or asked for. */
    newest: number;
    person_earlier: number;
    expanded: number;
    before?: string | number;
    after?: string | number;
  };
  cursor: number;
  url: string;
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
const ANSWERS_HEADING = new RegExp(`^## ${QUESTION_ANSWERS_HEADING}$`);

/** "512 B", "12.3 KB". */
export function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** `2026-10-19 16:42Z`: minutes are enough to read a thread by. */
export function shortTime(iso: string): string {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : iso;
}

/** At most `max` UTF-8 bytes of `text`, never inside a character. */
function cutToBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
}

/** At most `max` characters, at a word boundary when one is near, with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const head = [...flat].slice(0, max).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

export function agentAuthor(author: InboxMessageWire["author"]): AgentAuthor {
  return author.kind === "person" ? { kind: "person" } : { kind: "agent", name: inboxAgentName(author) };
}

function authorName(author: AgentAuthor): string {
  return author.kind === "person" ? "the person" : author.name;
}

/** `to you`, or `to another session (Claude Code ses_…)`: a person's message meant for one session. */
function addresseeWords(to: AgentAddressee | undefined): string | null {
  if (!to) return null;
  return to.you ? "to you" : `to another session (${INBOX_HOST_NAMES[to.host] ?? to.host} ${to.session})`;
}

/** `tagged you, Pi (pi-0193)`: the sessions a person's reply tags, the reader first as `you`. */
function taggedWords(tagged: readonly AgentTagged[] | undefined): string | null {
  if (!tagged?.length) return null;
  const you = tagged.filter((t) => t.you);
  const others = tagged.filter((t) => !t.you).map((t) => `${t.agent} (${t.session})`);
  return `tagged ${[...(you.length > 0 ? ["you"] : []), ...others].join(", ")}`;
}

/** The tags a wire message carries as `store.agentThread` writes them (`tagged`), with the reader marked. */
function taggedOf(message: InboxMessageWire, caller: string | null): AgentTagged[] | undefined {
  const tagged = (message as { tagged?: unknown }).tagged;
  if (!Array.isArray(tagged) || tagged.length === 0) return undefined;
  return tagged.flatMap((t) =>
    t && typeof t === "object" && typeof (t as { session?: unknown }).session === "string"
      ? [{ agent: String((t as { agent?: unknown }).agent ?? "An agent"), session: (t as { session: string }).session, you: !!caller && (t as { session: string }).session === caller }]
      : [],
  );
}

export function agentAnswer(answer: QuestionAnswer | null | undefined): AgentAnswer | undefined {
  if (!answer) return undefined;
  const out: AgentAnswer = {};
  if (answer.selected?.length) out.selected = [...answer.selected];
  if (answer.other) out.other = answer.other;
  if (answer.text) out.text = answer.text;
  if (answer.note) out.note = answer.note;
  if (answer.skipped) out.skipped = true;
  if (answer.skipped && answer.by_reply) out.by_reply = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A question's answer in words, whole: each value as a JSON string, so a
 * free-text answer, a note or Other (up to 4,000 characters each) keeps every
 * character and line break, and its end is never lost. `"Yes"; note: "…"`,
 * `skipped`.
 */
export function answerWords(answer: AgentAnswer | undefined): string {
  if (!answer) return "";
  if (answer.skipped) return answer.by_reply ? "skipped by the person" : "skipped";
  const parts = (answer.selected ?? []).map((label) => JSON.stringify(label));
  if (answer.other) parts.push(`Other: ${JSON.stringify(answer.other)}`);
  if (answer.text) parts.push(JSON.stringify(answer.text));
  if (answer.note) parts.push(`note: ${JSON.stringify(answer.note)}`);
  return parts.join("; ");
}

/**
 * Each question's number in its message: its rank by position, as the reply's
 * answers section numbers it. Action items (`kind: "action"`) are numbered on their
 * own (A1, A2…), as the reply's "Action items you asked for" numbers them.
 */
function numbering(questions: readonly InboxQuestion[]): Map<string, number> {
  const rank = (list: readonly InboxQuestion[]) => [...list].sort((a, b) => a.position - b.position).map((q, i) => [q.key, i + 1] as const);
  return new Map([...rank(questions.filter((q) => q.kind !== "action")), ...rank(questions.filter((q) => q.kind === "action"))]);
}

/** An action item's result in words, for the agent (`AgentQuestionRef.result`). */
function actionResultWords(q: InboxQuestion): string | null {
  const result = q.action_result;
  if (q.kind !== "action" || !result) return null;
  if (result.by === "agent") return result.person?.note && q.revision !== q.sent_revision ? "you saw it done (the person's note on it is in their reply draft, not sent yet)" : "you saw it done";
  // In the person's reply draft (approval "inbox-action-items-in-reply"), or inside the timed path's Undo window.
  const pending = q.state === "picked" ? (result.staged ? " (in the person's reply draft, not sent yet)" : " (not sent yet: the person can still undo it)") : "";
  if (result.outcome === "cant") return `can't do it: ${JSON.stringify(result.note ?? "")}${pending}`;
  return `done${result.note ? `, note: ${JSON.stringify(result.note)}` : ""}${pending}`;
}

function questionRef(q: InboxQuestion, n: number): AgentQuestionRef {
  const answer = agentAnswer(q.answer);
  const result = actionResultWords(q);
  return {
    key: q.key,
    q: n,
    state: q.state,
    ...(answer ? { answer } : {}),
    ...(result ? { result } : {}),
    ...(q.superseded_by ? { superseded_by: q.superseded_by.key ? `${q.superseded_by.message_id}/${q.superseded_by.key}` : q.superseded_by.message_id } : {}),
  };
}

export function agentQuestions(questions: readonly InboxQuestion[]): AgentQuestion[] {
  const n = numbering(questions);
  return questions.map((q) => ({ ...questionRef(q, n.get(q.key) ?? 1), kind: q.kind, prompt: q.prompt }));
}

/**
 * One question in words: `Q1 q-abc sent: "Yes"`, `Q2 q-def open`, `Q3 q-… replaced by msg_…/q-…`.
 * `withPrompt` names the prompt (a one-line message); `withAnswer` false
 * leaves the answer out (wait_for_reply, whose reply body words it).
 */
export function questionWords(q: AgentQuestionRef, withPrompt = false, withAnswer = true): string {
  // An action item (key `a-…`) reads A1, A2…: the reply's "Action items you asked for" numbers it so.
  const head = `${q.key.startsWith("a-") ? "A" : "Q"}${q.q} ${q.key}${withPrompt && q.prompt ? ` (${JSON.stringify(q.prompt)})` : ""}`;
  if (q.result) return `${head} ${q.result}`;
  if (q.state === "superseded") return `${head} ${q.superseded_by?.includes("/") ? `replaced by ${q.superseded_by}` : "no longer applies"}`;
  const answer = withAnswer ? answerWords(q.answer) : "";
  if (q.state === "picked") return `${head} picked, not sent${answer ? `: ${answer}` : ""}`;
  if (q.state === "sent") return `${head} sent${answer ? `: ${answer}` : ""}`;
  if (q.state === "closed") return `${head} closed${answer ? ` (${answer})` : ""}`;
  return `${head} open`;
}

/**
 * A reply's "Answers to your questions" section, left out: each answer is
 * already on its question (the asking message's line or its full form, or
 * the result's `thread.questions`), with its state. Only that section is cut,
 * exactly: the person's words before it, and their feedback and skills block
 * after it, stay. Used for the person's earlier messages only; a reply in the
 * window, or expanded, is as sent.
 */
export function withoutAnswersSection(message: InboxMessageWire): string {
  const lines = message.body.split("\n");
  for (let at = 0; at < lines.length; at++) {
    if (!ANSWERS_HEADING.test(lines[at]!) || (at > 0 && lines[at - 1] !== "")) continue;
    const end = inboxAnswersSectionEnd(lines, at);
    if (end === null) continue;
    const marker = `[${QUESTION_ANSWERS_HEADING}: left out here; each answer is on its question above, and expand shows this reply as sent]`;
    const rest = lines.slice(end);
    return [...lines.slice(0, at), marker, ...(rest.length > 0 ? ["", ...rest] : [])].join("\n").trimEnd();
  }
  return message.body;
}

/**
 * How a message is shown in full: `window` (a body over 16 KB is cut),
 * `earlier` (one of the person's earlier messages: also without its answers
 * section), or `whole` (expanded or asked for: exactly as sent).
 */
export type AgentMessageForm = "window" | "earlier" | "whole";

/** A message in full, as read_thread shows it. */
/** Who a person's message is addressed to, if anyone. */
function addressee(message: InboxMessageWire, caller: string | null): AgentAddressee | undefined {
  return message.to ? { host: message.to.host, session: message.to.session, you: !!caller && message.to.session === caller } : undefined;
}

export function agentMessage(message: InboxMessageWire, form: AgentMessageForm = "window", caller: string | null = null): AgentMessage {
  const source = form === "earlier" ? withoutAnswersSection(message) : message.body;
  const total = byteLength(message.body);
  const over = form !== "whole" && byteLength(source) > INBOX_BODY_CUT_BYTES;
  const body = over
    ? `${cutToBytes(source, INBOX_BODY_CUT_BYTES)}\n\n[… cut: ${sizeText(INBOX_BODY_CUT_BYTES)} of ${sizeText(total)} shown; read_thread expand: ["${message.id}"] shows the rest]`
    : source;
  const ack = message.ack && typeof message.ack === "object" ? message.ack : null;
  return {
    id: message.id,
    author: agentAuthor(message.author),
    created_at: message.created_at,
    reply_to: message.reply_to,
    body,
    ...(body !== message.body ? { body_bytes: total } : {}),
    ...(message.questions?.length ? { questions: agentQuestions(message.questions) } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map((a) => ({ name: a.name, kind: a.kind, size: a.size, path: a.path })) } : {}),
    ...(ack ? { ack: { label: ack.label, at: ack.at } } : {}),
    ...(message.guide ? { guide: { title: message.guide.title } } : {}),
    ...(message.to ? { to: addressee(message, caller) } : {}),
    ...(taggedOf(message, caller) ? { tagged: taggedOf(message, caller) } : {}),
    ...(message.board_request === true ? { board_request: true as const } : {}),
  };
}

/** The first words of a message, plain: the person's own words in a reply, else the body's text. */
function firstWords(message: InboxMessageWire): string {
  let text = message.author.kind === "person" ? inboxSearchReplyText(message.body, message) : inboxSearchBodyText(message.body);
  // A message that is only question blocks: its first question's prompt (never ":::question").
  if (!text.trim()) text = [...(message.questions ?? [])].sort((a, b) => a.position - b.position)[0]?.prompt ?? "";
  if (!text.trim()) text = message.body.split("\n").find((line) => line.trim() !== "" && !/^:{3,}/.test(line.trim())) ?? "";
  return clip(text, INBOX_LINE_WORDS);
}

export function agentMessageLine(message: InboxMessageWire, caller: string | null = null): AgentMessageLine {
  const n = numbering(message.questions ?? []);
  return {
    id: message.id,
    author: agentAuthor(message.author),
    created_at: message.created_at,
    reply_to: message.reply_to,
    words: firstWords(message),
    bytes: byteLength(message.body),
    ...(message.questions?.length ? { questions: message.questions.map((q) => ({ ...questionRef(q, n.get(q.key) ?? 1), prompt: clip(q.prompt, INBOX_LINE_PROMPT_CHARS) })) } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map((a) => a.name) } : {}),
    ...(message.guide ? { guide: message.guide.title } : {}),
    ...(message.ack ? { ack: true as const } : {}),
    ...(message.to ? { to: addressee(message, caller) } : {}),
    ...(taggedOf(message, caller) ? { tagged: taggedOf(message, caller) } : {}),
    ...(message.board_request === true ? { board_request: true as const } : {}),
  };
}

/** A before / after bound as a seq: a cursor, digits, or a message id of this thread. */
function boundOf(store: InboxStore, ids: ReadonlySet<string>, value: string | number | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Math.floor(value);
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!ids.has(text)) throw new InboxError("validation_error", `${name}: ${text} is not a message of this thread (pass one of its message ids, or a cursor).`);
  return store.messageCursor(text) ?? 0;
}

/**
 * The windowed read of a thread (structured), from the thread as an agent
 * reads it, and the order its shown messages came in (oldest first).
 */
export function windowedThread(
  store: InboxStore,
  threadId: string,
  input: ThreadReadInput,
  url: string,
): { result: ThreadWindowResult; order: string[]; shown: Set<string>; readThrough: number } {
  // With the reader, so a reply that tags it reads `tagged_you` (approval "inbox-tag-agents").
  const thread = store.agentThread(threadId, input.caller ?? null);
  if (!thread) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
  // A reply that tags agents names its owner as `to` (the session it goes to anyway), so the transcript says who it is for.
  const all = thread.messages.map((message) => {
    // A Tidy note reads as one line here: its session had the whole list in its wake.
    if (message.tidy) return { ...message, body: `Tidy: the person asked ${INBOX_HOST_NAMES[message.to?.host ?? ""] ?? "the agent"} to tidy its threads; this one was listed.` };
    if (message.to || !(message as { tagged?: unknown }).tagged) return message;
    const stored = store.message(message.id);
    const owner = stored ? store.recipientOf(stored) : null;
    return owner ? { ...message, to: { host: owner.host ?? "agent", session: owner.session } } : message;
  });
  const ids = new Set(all.map((m) => m.id));
  const seq = new Map(all.map((m) => [m.id, store.messageCursor(m.id) ?? 0]));
  const limit = input.limit ?? INBOX_THREAD_WINDOW;

  if ((input.expand?.length ?? 0) > INBOX_EXPAND_MAX) throw new InboxError("validation_error", `expand: at most ${INBOX_EXPAND_MAX} message ids.`);
  const expand = new Set<string>();
  for (const id of input.expand ?? []) {
    const trimmed = id.trim();
    if (!ids.has(trimmed)) throw new InboxError("validation_error", `expand: ${trimmed} is not a message of this thread.`);
    expand.add(trimmed);
  }
  if (input.message_id && ids.has(input.message_id)) expand.add(input.message_id);

  const after = boundOf(store, ids, input.after, "after");
  const before = boundOf(store, ids, input.before, "before");
  const inRange = all.filter((m) => (after === null || seq.get(m.id)! > after) && (before === null || seq.get(m.id)! < before));
  const newest = new Set(inRange.slice(-limit).map((m) => m.id));
  const full = new Set(newest);
  for (const id of expand) full.add(id);
  // The person's newest message is shown whole, whatever its size, and never folded into a line.
  const whole = new Set(expand);
  const personNewest = [...inRange].reverse().find((m) => m.author.kind === "person" && !isInboxNote(m));
  if (personNewest) {
    full.add(personNewest.id);
    whole.add(personNewest.id);
  }

  // The person's earlier messages, newest first, while they fit (each as `earlier` shows it).
  const personEarlier = new Set<string>();
  let used = 0;
  for (const message of [...inRange].reverse()) {
    if (full.has(message.id) || message.author.kind !== "person") continue;
    const size = Math.min(byteLength(withoutAnswersSection(message)), INBOX_BODY_CUT_BYTES);
    // One long reply does not fold every older one into a line: the next ones may still fit.
    if (used + size > INBOX_EARLIER_PERSON_BYTES) continue;
    used += size;
    full.add(message.id);
    personEarlier.add(message.id);
  }

  const shown = new Set(inRange.map((m) => m.id));
  for (const id of full) shown.add(id);
  const formOf = (id: string): AgentMessageForm => (whole.has(id) ? "whole" : personEarlier.has(id) ? "earlier" : "window");
  const caller = input.caller ?? null;
  // A Board request in full names the cards that link the thread already (review of #2249: no second card on a re-read).
  // Only cards still in flight: a shipped card is done (new work in the thread gets a new card), and the card
  // list op hides shipped and dropped cards by default, so the agent's list agrees with this line.
  const linkedCards = () =>
    store
      .listCards({ projectIds: new Set([thread.project.id]) })
      .filter((card) => card.column !== "dropped" && card.column !== "shipped" && card.threads.includes(threadId))
      .map((card) => ({ id: card.id, title: card.title }));
  const messages = all
    .filter((m) => full.has(m.id))
    .map((m) => agentMessage(m, formOf(m.id), caller))
    .map((m) => (m.board_request ? { ...m, board_cards: linkedCards() } : m));
  const earlier = inRange.filter((m) => !full.has(m.id)).map((m) => agentMessageLine(m, caller));
  const leftOut = all.filter((m) => !shown.has(m.id));
  // The questions of messages left out, without repeating what the reader has:
  // open and picked ones are in the header; for a message older than `after`
  // only a question whose state changed since (a pick, an answer, a
  // replacement, a Mark read, the archive), so a read of what is new stays
  // small however long the thread; for a message newer than `before`, every one.
  const archived = store.archiveSeq(threadId);
  const changedSince = (q: InboxQuestion, messageId: string): boolean =>
    after !== null && ((store.questionLineSeq(`${messageId}/${q.key}`) ?? 0) > after || (q.state === "closed" && archived !== null && archived > after));
  const elsewhere = leftOut.flatMap((m) => {
    const n = numbering(m.questions ?? []);
    const older = after !== null && seq.get(m.id)! <= after;
    return (m.questions ?? [])
      .filter((q) => q.state !== "open" && q.state !== "picked" && (!older || changedSince(q, m.id)))
      .map((q) => ({ message_id: m.id, ...questionRef(q, n.get(q.key) ?? 1), prompt: clip(q.prompt, INBOX_LINE_PROMPT_CHARS) }));
  });

  const open_questions: AgentOpenQuestion[] = [];
  for (const message of all) {
    if (!message.questions?.length) continue;
    const n = numbering(message.questions);
    for (const q of message.questions) {
      if (q.state !== "open" && q.state !== "picked") continue;
      open_questions.push({
        message_id: message.id,
        ...questionRef(q, n.get(q.key) ?? 1),
        kind: q.kind,
        prompt: q.prompt,
        choices: q.choices.map((c) => c.label),
      });
    }
  }

  const participants = new Map<string, { kind: "person" | "agent"; name: string; messages: number }>();
  for (const message of all) {
    const author = agentAuthor(message.author);
    const name = authorName(author);
    const entry = participants.get(`${author.kind}:${name}`) ?? { kind: author.kind, name, messages: 0 };
    entry.messages += 1;
    participants.set(`${author.kind}:${name}`, entry);
  }

  const result: ThreadWindowResult = {
    thread: {
      thread_id: thread.thread_id,
      subject: thread.subject,
      thread_name: thread.thread_name,
      resolved_at: thread.resolved_at,
      project: { id: thread.project.id, name: thread.project.name, root: thread.project.root },
      message_count: all.length,
      participants: [...participants.values()],
      open_questions,
      messages,
      earlier,
      ...(elsewhere.length > 0 ? { questions: elsewhere } : {}),
    },
    window: {
      limit,
      full: messages.length,
      lines: earlier.length,
      left_out: leftOut.length,
      newest: newest.size,
      person_earlier: [...personEarlier, ...(personNewest && !newest.has(personNewest.id) && !expand.has(personNewest.id) ? [personNewest.id] : [])].filter((id) => !newest.has(id)).length,
      expanded: [...expand].filter((id) => !newest.has(id) && !personEarlier.has(id)).length,
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
    },
    cursor: store.cursor(),
    url,
  };
  const lineIds = new Set(earlier.map((line) => line.id));
  const order = all.filter((m) => full.has(m.id) || lineIds.has(m.id)).map((m) => m.id);
  // What the read may mark read: everything up to `before` (a newer reply it
  // left out must still wake its session and stay unread), and the acks of
  // the messages it showed (an ack on a message `after` left out is not seen).
  return { result, order, shown: new Set(order), readThrough: before === null ? Number.POSITIVE_INFINITY : before - 1 };
}

/**
 * What the message printed just before this one in a transcript says, so the
 * next one can leave out what it repeats: the date (a time alone on the same
 * day), and `reply to` when it answers that very message.
 */
export interface TranscriptContext {
  previousId: string | null;
  previousDate: string | null;
  rootId: string;
}

function whenAndWhat(item: { id: string; created_at: string; reply_to: string | null }, context: TranscriptContext): string[] {
  const date = item.created_at.slice(0, 10);
  const time = shortTime(item.created_at);
  const parts = [date === context.previousDate ? time.slice(11) : time];
  if (item.reply_to && item.reply_to !== context.previousId) parts.push(`reply to ${item.reply_to}`);
  else if (!item.reply_to && item.id !== context.rootId) parts.push("not a reply");
  context.previousId = item.id;
  context.previousDate = date;
  return parts;
}

/** One message as one line of text. */
export function messageLineText(line: AgentMessageLine, context: TranscriptContext): string {
  const parts = [`- ${line.id}`, authorName(line.author), ...whenAndWhat(line, context)];
  const to = addresseeWords(line.to);
  if (to) parts.push(to);
  const tagged = taggedWords(line.tagged);
  if (tagged) parts.push(tagged);
  parts.push(`"${line.words}" (${sizeText(line.bytes)})`);
  if (line.questions?.length) parts.push(line.questions.map((q) => questionWords(q, true)).join("; "));
  if (line.attachments?.length) parts.push(`files: ${line.attachments.join(", ")}`);
  if (line.guide) parts.push(`guided review: ${line.guide}`);
  if (line.ack) parts.push("👍");
  // Shown in full only: the line says it is there, so a reader that sees just the line expands it.
  if (line.board_request) parts.push(`Board request (read_thread expand: ["${line.id}"] shows it)`);
  return parts.join(" · ");
}

/** One message in full as text: a heading line, the body, then its questions, files, guide and 👍. */
export function messageText(message: AgentMessage, context: TranscriptContext): string {
  const head = [message.id, authorName(message.author), ...whenAndWhat(message, context)];
  const to = addresseeWords(message.to);
  if (to) head.push(to);
  const tagged = taggedWords(message.tagged);
  if (tagged) head.push(tagged);
  const lines = [`[${head.join(" · ")}]`, message.body.trimEnd()];
  if (message.questions?.length) lines.push(`Questions: ${message.questions.map((q) => questionWords(q)).join("; ")}`);
  if (message.attachments?.length) {
    lines.push(`Files: ${message.attachments.map((a) => `${a.name} (${a.kind}, ${sizeText(a.size)}): ${a.path}`).join("; ")}`);
  }
  if (message.guide) lines.push(`Guided review: ${message.guide.title}`);
  if (message.ack) lines.push(`👍 ${message.ack.label} (${shortTime(message.ack.at)}): the person read it and needs nothing more.`);
  // Compose's Board chip: the request, once, after the words and files (the wake's order), and the cards
  // that link the thread already, so a second reader keeps those current instead of making more.
  if (message.board_request) {
    lines.push("", inboxBoardRequestBlock(message.id));
    if (message.board_cards?.length) {
      lines.push(`Already on the Board for this thread: ${message.board_cards.map((c) => `${c.id} (${c.title})`).join("; ")}. Keep ${message.board_cards.length === 1 ? "it" : "them"} current; make no other.`);
    }
  }
  return lines.join("\n");
}

/** The whole windowed read as text: complete for an agent (the JSON adds nothing it needs). */
export function windowedThreadText(result: ThreadWindowResult, order: readonly string[], extra = ""): string {
  const { thread, window } = result;
  const persons = thread.participants.filter((p) => p.kind === "person").reduce((sum, p) => sum + p.messages, 0);
  const out: string[] = [];
  out.push(
    `Thread ${thread.thread_id}${thread.subject ? ` (${thread.subject})` : ""}: ${thread.message_count} message${thread.message_count === 1 ? "" : "s"}, ${persons} from the person${thread.resolved_at ? ", resolved" : ""}.`,
  );
  const facts = [
    thread.thread_name ? `Name: ${thread.thread_name}` : null,
    `Project: ${thread.project.name} (${thread.project.root})`,
    `From: ${thread.participants.map((p) => `${p.name} ${p.messages}`).join(", ")}`,
    thread.resolved_at ? `Resolved ${shortTime(thread.resolved_at)}` : null,
    result.url,
  ].filter((part): part is string => part !== null);
  out.push(facts.join(" · "));
  if (thread.open_questions.length === 0) {
    out.push("No question waits on the person.");
  } else {
    out.push(`Waiting on the person (${thread.open_questions.length}):`);
    for (const q of thread.open_questions) {
      // An action item (key `a-…`): A1, A2…, "action item, open", or what the person marked and has not sent (in their reply draft, or inside its Undo window).
      const todo = q.key.startsWith("a-");
      const state = todo
        ? q.state === "picked"
          ? `${q.result ?? "marked"}`
          : "action item, open"
        : q.state === "picked"
          ? `picked, not sent${q.answer ? `: ${answerWords(q.answer)}` : ""}`
          : "open";
      const choices = q.choices.length > 0 ? ` Choices: ${q.choices.map((c) => clip(c, 200)).join(" | ")}` : "";
      out.push(`- ${q.message_id}/${q.key} (${todo ? "A" : "Q"}${q.q}) ${state}: ${q.prompt}${choices}`);
    }
  }
  if (thread.questions?.length) {
    out.push(`Questions of messages not shown: ${thread.questions.map((q) => `${q.message_id}/${questionWords(q, true)}`).join("; ")}`);
  }
  const range = window.after !== undefined || window.before !== undefined
    ? ` Range:${window.after !== undefined ? ` after ${window.after}` : ""}${window.before !== undefined ? ` before ${window.before}` : ""}; ${window.left_out} other message${window.left_out === 1 ? "" : "s"} left out.`
    : "";
  out.push(
    `Shown: ${window.full} in full (the newest ${window.newest}${window.person_earlier > 0 ? `, ${window.person_earlier} earlier from the person (up to ${sizeText(INBOX_EARLIER_PERSON_BYTES)})` : ""}${window.expanded > 0 ? `, ${window.expanded} expanded` : ""}) and ${window.lines} earlier as one line each.${range} A message replies to the one above it unless it says otherwise; times are UTC. read_thread expand: [ids] shows messages in full; before: <id> reads further back; after: <cursor> returns only what is new.`,
  );
  out.push("");
  // Oldest first, one line or in full.
  const lines = new Map(thread.earlier.map((line) => [line.id, line]));
  const fulls = new Map(thread.messages.map((message) => [message.id, message]));
  const context: TranscriptContext = { previousId: null, previousDate: null, rootId: thread.thread_id };
  let previousWasLine = false;
  for (const id of order) {
    const line = lines.get(id);
    if (line) {
      out.push(messageLineText(line, context));
      previousWasLine = true;
      continue;
    }
    if (previousWasLine) out.push("");
    out.push(messageText(fulls.get(id)!, context), "");
    previousWasLine = false;
  }
  if (out.at(-1) !== "") out.push("");
  out.push(`Cursor ${result.cursor}: read_thread after: ${result.cursor} returns only what is new since this read.${extra}`);
  return out.join("\n");
}
