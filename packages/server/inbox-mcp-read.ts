/**
 * read_thread's thread mode as an agent reads it (step 2 of the Inbox MCP
 * size work; .product/drafts/inbox-mcp-size/FINDINGS.md): a window, not the
 * whole thread.
 *
 * - The header: subject, name, who wrote, and every question still waiting
 *   on the person (open or picked) with its key, state and prompt (clipped to
 *   INBOX_HEADER_PROMPT_CHARS), and its choices while they total at most
 *   INBOX_HEADER_CHOICES_CHARS (a question in an attached file keeps them).
 * - The newest `limit` messages (default 6) in full, and the person's newest
 *   message, as sent, wherever it is.
 * - The INBOX_THREAD_LINES most recent other messages as one line each (at
 *   most INBOX_LINE_MAX_CHARS): id, author, time, first words, size, the
 *   sections a reply carries after its words, and each of its questions with
 *   its state and answer. Older ones are one count line naming the `before`
 *   call, except the reader's unread replies (the oldest INBOX_UNREAD_LINES),
 *   listed under it.
 * - In any other message shown in full, a skills block's instructions are one
 *   marker line and a body over INBOX_BODY_CUT_BYTES (16 KB) is cut; both
 *   markers name the `expand` call that shows the message as sent. A settled
 *   Re-ask note says it is settled, and outside `expand` and the person's
 *   newest message its list and steps are left out too.
 *
 * No open or picked question is ever lost: each is in the header. Any other
 * question is on a message shown in full, on a one-line message, for a
 * message older than `after` whose question changed since in
 * `thread.questions`, or a read without `before` / with `before` away.
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

import { INBOX_ROWS_ASK_BLOCK } from "@plannotator/core/inbox-types";
import { INBOX_DECISION_ASK_BLOCK, INBOX_HOST_NAMES, inboxAgentName, inboxBoardRequestBlock, inboxSentFromLine, isInboxNote, type InboxMessageWire, type InboxMovedTo, type InboxQuestion } from "@plannotator/core/inbox-types";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { splitInboxSkillsBlock } from "@plannotator/core/skill-reference-block";
import { INBOX_ACTIONS_HEADING } from "@plannotator/core/inbox-actions";
import { INBOX_ATTACHMENT_FEEDBACK_TITLE, INBOX_GUIDE_FEEDBACK_TITLE, INBOX_MESSAGE_FEEDBACK_TITLE, INBOX_OWN_MESSAGE_FEEDBACK_TITLE } from "@plannotator/core/inbox-review";
import { inboxAckReaction } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { inboxSearchBodyText, inboxSearchReplyText } from "@plannotator/shared/inbox/search";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_TIDY_WITHDRAWN_HOST } from "@plannotator/shared/inbox/tidy";
import { inboxViewingLine } from "@plannotator/shared/inbox/uploads";
import { reviewAnchorBlock, reviewAnchorPlace } from "@plannotator/core/review-threads";
import type { AgentFile } from "./inbox-agent-files";
import { inboxMessageForReader, type InboxSentFromReader } from "./inbox-sent-from-reader";

/** Messages read_thread shows in full by default: the newest six. */
export const INBOX_THREAD_WINDOW = 6;
/** A body longer than this is cut, with a marker naming the `expand` call. */
export const INBOX_BODY_CUT_BYTES = 16 * 1024;
/** At most this many messages as one line each, the most recent; older ones are one count line naming `before`. */
export const INBOX_THREAD_LINES = 30;
/** At most this many of the reader's unread replies older than the one-line messages are listed too, the oldest first. */
export const INBOX_UNREAD_LINES = 20;
/** A one-line message at most this long: past it, its questions lose their prompts and answers, then the line is clipped. */
export const INBOX_LINE_MAX_CHARS = 400;
/** A clipped one-line message keeps at least this many characters of its first words before its questions lose their prompts. */
export const INBOX_LINE_MIN_WORDS = 24;
/** An open question's prompt in the header, clipped to this; its ref is always whole. */
export const INBOX_HEADER_PROMPT_CHARS = 300;
/** The header lists the open questions' choices while they total at most this many characters; past it, expand shows them in the message. */
export const INBOX_HEADER_CHOICES_CHARS = 3000;
/** First words of a one-line message. */
export const INBOX_LINE_WORDS = 120;
/** At most this many ids in `expand`. */
export const INBOX_EXPAND_MAX = 50;


/**
 * An author as an agent reads it: the person, or an agent by the name the person sees, with `you: true`
 * on the reader's own messages (the session that reads is the session that wrote), so two sessions of
 * one agent in a thread read apart. Worked out at read time; nothing stored changes.
 */
export type AgentAuthor = { kind: "person" } | { kind: "agent"; name: string; you?: true };

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
   * A question asked inside a file the message attached (issue #2828): the
   * file's name. `q` then numbers it among that file's questions, as the
   * reply's answers section does under "Your file <name>, attached to message <id>".
   */
  file?: string;
  /** On a one-line message and in `thread.questions`: the prompt, clipped, so an answer ("Yes") says what it answers. */
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
  /** The body is not shown as sent (cut at INBOX_BODY_CUT_BYTES, or a skills block's instructions or a Re-ask note's steps left out): its full size in bytes; expand shows it whole. */
  body_bytes?: number;
  questions?: AgentQuestion[];
  attachments?: { name: string; kind: string; size: number; path: string }[];
  /** In place of `attachments` for a cloud agent (`ThreadReadInput.filesOf`): each file with its path and the command that fetches it. */
  files?: AgentFile[];
  /** The person's reaction (approval "inbox-reaction-tray"): always `reaction`, 👍 Looks good included. */
  ack?: { label: string; at: string; reaction: { emoji: string; label?: string } };
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
  /** Asked from Decision data: `messageText` puts `INBOX_DECISION_ASK_BLOCK` after the body; `body` stays the person's words. */
  decision_ask?: true;
  /** Asked from Settings → Rows: `messageText` puts `INBOX_ROWS_ASK_BLOCK` after the body; `body` stays the person's words. */
  rows_ask?: true;
  /** With `board_request`: the cards in flight that link this thread already (not done, not dropped), for `messageText`. */
  board_cards?: { id: string; title: string }[];
  /** `inboxViewingLine`, on a reply sent from full screen's floating box. `body` stays the person's words. */
  viewing?: string;
  /** `inboxSentFromLine`, on a message the person wrote away from this computer. `body` stays the person's words. */
  sent_from?: string;
  review_comment?: string;
}

/** One agent session a person's reply tags, as an agent reads it. */
export interface AgentTagged {
  agent: string;
  session: string;
  /** The session's name as the person's window shows it (their rename, else its generated title); absent when it has none. */
  name?: string;
  you: boolean;
}

/** Who a person's message is for: the session's host and id, and whether that is the reader (`you`). */
export interface AgentAddressee {
  host: string;
  session: string;
  /** The session's name as the person's window shows it; absent when it has none. */
  name?: string;
  you: boolean;
}

export type SessionNameOf = (session: string) => string | null;

/**
 * Another session as an agent reads it: `Pi (pi-0193)`, and with the name the person's window shows for it,
 * `"docs sweep" (Pi pi-0193)`. The name is quoted: it is display text, never an id.
 */
export function sessionWho(agent: string, session: string, name: string | null | undefined): string {
  return name ? `${JSON.stringify(name)} (${agent} ${session})` : `${agent} (${session})`;
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
  /** With `ack`: the emoji the person reacted with, 👍 included (approval "inbox-reaction-tray"); the line shows it, never its name. */
  reaction?: string;
  to?: AgentAddressee;
  tagged?: AgentTagged[];
  board_request?: true;
  viewing?: string;
  sent_from?: string;
  review_comment?: string;
  /** The sections a reply carries after its words (action items, feedback), named so the reader knows to expand it. */
  carries?: string[];
  /** A reply of the person's the reader has not had, listed though older than the one-line messages. */
  unread?: true;
}

export interface ThreadReadInput {
  limit?: number;
  expand?: string[];
  before?: string | number;
  after?: string | number;
  message_id?: string;
  /** The reader's session: a message addressed to it says `you`. */
  caller?: string | null;
  names?: SessionNameOf;
  /** Through the agent door: a message's files with their paths here and the command that fetches each to the agent's machine. */
  filesOf?: (message: InboxMessageWire) => AgentFile[];
  /** A far read's reader (inbox-sent-from-reader.ts): where the person wrote each message, as its computer sees it. */
  farReader?: InboxSentFromReader;
}

export interface ThreadWindowResult {
  thread: {
    thread_id: string;
    subject: string | null;
    thread_name: string | null;
    resolved_at: string | null;
    /** An archived thread whose questions an agent moved to another thread (resolve_message's moved_to). Absent otherwise. */
    moved_to?: InboxMovedTo;
    project: { id: string; name: string; root: string };
    message_count: number;
    /** `you: true` on the reader's own session (its messages counted apart from another session of the same agent). */
    participants: { kind: "person" | "agent"; name: string; messages: number; you?: true }[];
    /** Every question still waiting on the person (open, or picked and not sent). */
    open_questions: AgentOpenQuestion[];
    /** Shown in full, oldest first: the window, the person's newest message, and any expanded or asked-for message. */
    messages: AgentMessage[];
    /** The INBOX_THREAD_LINES most recent other messages in range, oldest first, one line each. */
    earlier: AgentMessageLine[];
    /** Questions of messages older than `after` whose state changed since the cursor (open and picked ones are in the header). */
    questions?: (AgentQuestionRef & { message_id: string })[];
  };
  window: {
    limit: number;
    /** Messages shown in full, as one line, and left out by before / after; the rest of `message_count` is older than the lines. */
    full: number;
    lines: number;
    left_out: number;
    /** Of `full`: the newest in range and the ones expanded or asked for; the person's newest message past them is the rest. */
    newest: number;
    expanded: number;
    /** The reader's unread replies past the INBOX_UNREAD_LINES listed: in the count line, still unread. */
    unread_left_out?: number;
    before?: string | number;
    after?: string | number;
  };
  cursor: number;
  url: string;
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

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

export function agentAuthor(author: InboxMessageWire["author"], caller: string | null = null): AgentAuthor {
  if (author.kind === "person") return { kind: "person" };
  const you = !!caller && author.session === caller;
  return { kind: "agent", name: inboxAgentName(author), ...(you ? { you: true as const } : {}) };
}

/** `the person`, `Claude Code`, or the reader's own `Claude Code (you)`. */
function authorName(author: AgentAuthor): string {
  if (author.kind === "person") return "the person";
  return author.you ? `${author.name} (you)` : author.name;
}

/** `to you`, or `to another session (Claude Code ses_…)`: a person's message meant for one session. */
function addresseeWords(to: AgentAddressee | undefined): string | null {
  if (!to) return null;
  if (to.you) return "to you";
  const agent = INBOX_HOST_NAMES[to.host] ?? to.host;
  return to.name ? `to another session ${sessionWho(agent, to.session, to.name)}` : `to another session (${agent} ${to.session})`;
}

/** `tagged you, Pi (pi-0193)`: the sessions a person's reply tags, the reader first as `you`. */
function taggedWords(tagged: readonly AgentTagged[] | undefined): string | null {
  if (!tagged?.length) return null;
  const you = tagged.filter((t) => t.you);
  const others = tagged.filter((t) => !t.you).map((t) => sessionWho(t.agent, t.session, t.name));
  return `tagged ${[...(you.length > 0 ? ["you"] : []), ...others].join(", ")}`;
}

/** The tags a wire message carries as `store.agentThread` writes them (`tagged`), with the reader marked. */
function taggedOf(message: InboxMessageWire, caller: string | null, names?: SessionNameOf): AgentTagged[] | undefined {
  const tagged = (message as { tagged?: unknown }).tagged;
  if (!Array.isArray(tagged) || tagged.length === 0) return undefined;
  return tagged.flatMap((t) => {
    if (!t || typeof t !== "object" || typeof (t as { session?: unknown }).session !== "string") return [];
    const session = (t as { session: string }).session;
    const you = !!caller && session === caller;
    const name = you ? null : (names?.(session) ?? null);
    return [{ agent: String((t as { agent?: unknown }).agent ?? "An agent"), session, ...(name ? { name } : {}), you }];
  });
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
  // A question inside an attached file (issue #2828) is numbered among that file's questions.
  const body = questions.filter((q) => !q.attachment);
  const files = [...new Set(questions.flatMap((q) => (q.attachment ? [q.attachment.id] : [])))];
  return new Map([
    ...rank(body.filter((q) => q.kind !== "action")),
    ...rank(body.filter((q) => q.kind === "action")),
    ...files.flatMap((id) => rank(questions.filter((q) => q.attachment?.id === id && q.kind !== "action"))),
  ]);
}

/** An action item's result in words, for the agent (`AgentQuestionRef.result`). */
function actionResultWords(q: InboxQuestion): string | null {
  const result = q.action_result;
  if (q.kind !== "action" || !result) return null;
  if (result.by === "agent") return result.person?.note && q.revision !== q.sent_revision ? "you saw it done (the person's note on it is in their reply draft, not sent yet)" : "you saw it done";
  // In the person's reply draft (approval "inbox-action-items-in-reply"), or inside the timed path's Undo window.
  const pending = q.state === "picked" ? (result.staged ? " (in the person's reply draft, not sent yet)" : " (not sent yet: the person can still undo it)") : "";
  if (result.outcome === "cant") return `can't do it: ${JSON.stringify(result.note ?? "")}${pending}`;
  if (result.outcome === "skip") return `skipped by the person${pending}`;
  return `done${result.note ? `, note: ${JSON.stringify(result.note)}` : ""}${pending}`;
}

function questionRef(q: InboxQuestion, n: number): AgentQuestionRef {
  const answer = agentAnswer(q.answer);
  const result = actionResultWords(q);
  return {
    key: q.key,
    q: n,
    state: q.state,
    ...(q.attachment ? { file: q.attachment.name } : {}),
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
 * `withPrompt` names the prompt (a one-line message).
 */
export function questionWords(q: AgentQuestionRef, withPrompt = false): string {
  // An action item (key `a-…`) reads A1, A2…: the reply's "Action items you asked for" numbers it so.
  const head = `${q.key.startsWith("a-") ? "A" : "Q"}${q.q}${q.file ? ` in your file ${q.file}` : ""} ${q.key}${withPrompt && q.prompt ? ` (${JSON.stringify(q.prompt)})` : ""}`;
  if (q.result) return `${head} ${q.result}`;
  if (q.state === "superseded") return `${head} ${q.superseded_by?.includes("/") ? `replaced by ${q.superseded_by}` : "no longer applies"}`;
  const answer = answerWords(q.answer);
  if (q.state === "picked") return `${head} picked, not sent${answer ? `: ${answer}` : ""}`;
  if (q.state === "sent") return `${head} sent${answer ? `: ${answer}` : ""}`;
  if (q.state === "closed") return `${head} closed${answer ? ` (${answer})` : ""}`;
  return `${head} open`;
}

/**
 * The person's message without its skills block's sections (each skill's
 * instructions, the Inbox's note on a skill): the heading and the list of
 * skills stay, the sections are one marker line naming the `expand` call.
 */
function withoutSkillSections(message: InboxMessageWire): string {
  if (message.author.kind !== "person") return message.body;
  const split = splitInboxSkillsBlock(message.body);
  if (!split) return message.body;
  const lines = split.block.split("\n");
  const listEnd = lines.findIndex((line, at) => at > 0 && !line.startsWith("- `"));
  const rest = listEnd < 0 ? [] : lines.slice(listEnd);
  if (rest.join("").trim() === "") return message.body;
  const skills = rest.flatMap((line) => /^--- BEGIN SKILL INSTRUCTIONS: (.+) ---$/.exec(line)?.[1] ?? []);
  const notes = rest.flatMap((line) => /^--- BEGIN PLANNOTATOR NOTE: (.+) ---$/.exec(line)?.[1] ?? []);
  const what = [...(skills.length > 0 ? [`the instructions of ${skills.join(", ")}`] : []), ...(notes.length > 0 ? [`the Inbox's note on ${notes.join(", ")}`] : [])];
  const marker = `[Left out here (${sizeText(byteLength(rest.join("\n").trim()))}): ${what.length > 0 ? what.join("; ") : "the rest of the skills block"}. read_thread expand: ["${message.id}"] shows them]`;
  return [split.before, ...(split.before ? [""] : []), ...lines.slice(0, listEnd), marker].join("\n");
}

/** Said under a settled Re-ask note, so the agent does not ask again. */
export const INBOX_REASK_SETTLED = "[Settled: every question this note asked again was since replaced, dropped, answered or closed; nothing is left to ask.]";

/** A settled Re-ask note shown in full: as sent, then the settled line after a blank line, or (`window`) its first line, the settled line and a marker. */
function settledNoteBody(message: InboxMessageWire, form: AgentMessageForm): string {
  if (form !== "window") return `${message.body}\n\n${INBOX_REASK_SETTLED}`;
  const [first = "", ...rest] = message.body.split("\n");
  return `${first}\n${INBOX_REASK_SETTLED}\n[Its list and steps (${sizeText(byteLength(rest.join("\n")))}): left out here; read_thread expand: ["${message.id}"] shows them]`;
}

/**
 * How a message is shown in full: `window` (without its skills block's
 * sections, and a body over 16 KB is cut), `unfolded` (a reply the reader has
 * not had: its skills block kept, a body over 16 KB cut), or `whole` (the
 * person's newest message, or expanded or asked for: exactly as sent).
 */
export type AgentMessageForm = "window" | "unfolded" | "whole";

/** A message in full, as read_thread shows it. */
/** Who a person's message is addressed to, if anyone. */
function addressee(message: InboxMessageWire, caller: string | null, names?: SessionNameOf): AgentAddressee | undefined {
  if (!message.to) return undefined;
  const you = !!caller && message.to.session === caller;
  const name = you ? null : (names?.(message.to.session) ?? null);
  return { host: message.to.host, session: message.to.session, ...(name ? { name } : {}), you };
}

export function agentMessage(message: InboxMessageWire, form: AgentMessageForm = "window", caller: string | null = null, names?: SessionNameOf, filesOf?: ThreadReadInput["filesOf"], settled = false): AgentMessage {
  const source = settled ? settledNoteBody(message, form) : form === "window" ? withoutSkillSections(message) : message.body;
  const total = byteLength(message.body);
  const over = form !== "whole" && byteLength(source) > INBOX_BODY_CUT_BYTES;
  const body = over
    ? `${cutToBytes(source, INBOX_BODY_CUT_BYTES)}\n\n[… cut: ${sizeText(INBOX_BODY_CUT_BYTES)} of ${sizeText(total)} shown; read_thread expand: ["${message.id}"] shows the rest]`
    : source;
  const ack = message.ack && typeof message.ack === "object" ? message.ack : null;
  return {
    id: message.id,
    author: agentAuthor(message.author, caller),
    created_at: message.created_at,
    reply_to: message.reply_to,
    body,
    ...(body !== message.body ? { body_bytes: total } : {}),
    ...(message.questions?.length ? { questions: agentQuestions(message.questions) } : {}),
    ...(filesOf ? filesField(filesOf(message)) : message.attachments?.length ? { attachments: message.attachments.map((a) => ({ name: a.name, kind: a.kind, size: a.size, path: a.path })) } : {}),
    ...(ack ? { ack: { label: ack.label, at: ack.at, reaction: agentReaction(ack.reaction) } } : {}),
    ...(message.guide ? { guide: { title: message.guide.title } } : {}),
    ...(message.to ? { to: addressee(message, caller, names) } : {}),
    ...(taggedOf(message, caller) ? { tagged: taggedOf(message, caller, names) } : {}),
    ...(message.board_request === true ? { board_request: true as const } : {}),
    ...(message.decision_ask === true ? { decision_ask: true as const } : {}),
    ...(message.rows_ask === true ? { rows_ask: true as const } : {}),
    ...(inboxViewingLine(message) ? { viewing: inboxViewingLine(message) } : {}),
    ...(inboxSentFromLine(message) ? { sent_from: inboxSentFromLine(message) } : {}),
    ...(message.review_anchor ? { review_comment: reviewCommentText(message) } : {}),
  };
}

/** A record in read_thread's `format: "full"`: what was on screen and where the person wrote it, as their lines, not their parts. */
export function inboxFullReadLines<M extends { viewing?: unknown; sent_from?: unknown }>(message: M): Omit<M, "viewing" | "sent_from"> & { viewing?: string; sent_from?: string } {
  // Nothing to word: the record as it was, so a read of an older reply is unchanged.
  if (!message.viewing && !message.sent_from) return message as Omit<M, "viewing" | "sent_from">;
  const { viewing, sent_from, ...rest } = message;
  const from = sent_from ? inboxSentFromLine(message) : "";
  return { ...rest, ...(viewing ? { viewing: inboxViewingLine(message as { viewing?: never }) } : {}), ...(from ? { sent_from: from } : {}) };
}

const filesField = (files: AgentFile[]) => (files.length > 0 ? { files } : {});

function reviewCommentText(message: InboxMessageWire): string {
  const resolved = message.review_resolved ? " The person resolved it." : "";
  return `${reviewAnchorBlock(message)}${resolved}`;
}

function reviewCommentLine(message: InboxMessageWire): string {
  return `review comment on ${reviewAnchorPlace(message.review_anchor!)}${message.review_resolved ? ", resolved" : ""}`;
}

/** The first words of a message, plain: the person's own words in a reply, else the body's text. */
function firstWords(message: InboxMessageWire): string {
  let text = message.author.kind === "person" ? inboxSearchReplyText(message.body, message) : inboxSearchBodyText(message.body);
  // A message that is only question blocks: its first question's prompt (never ":::question").
  if (!text.trim()) text = [...(message.questions ?? [])].sort((a, b) => a.position - b.position)[0]?.prompt ?? "";
  if (!text.trim()) text = message.body.split("\n").find((line) => line.trim() !== "" && !/^:{3,}/.test(line.trim())) ?? "";
  return clip(text, INBOX_LINE_WORDS);
}

export function agentMessageLine(message: InboxMessageWire, caller: string | null = null, names?: SessionNameOf): AgentMessageLine {
  const n = numbering(message.questions ?? []);
  return {
    id: message.id,
    author: agentAuthor(message.author, caller),
    created_at: message.created_at,
    reply_to: message.reply_to,
    words: firstWords(message),
    bytes: byteLength(message.body),
    ...(message.questions?.length ? { questions: message.questions.map((q) => ({ ...questionRef(q, n.get(q.key) ?? 1), prompt: clip(q.prompt, INBOX_LINE_PROMPT_CHARS) })) } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map((a) => a.name) } : {}),
    ...(message.guide ? { guide: message.guide.title } : {}),
    ...(message.ack ? { ack: true as const } : {}),
    ...(message.ack ? { reaction: inboxAckReaction(message.ack.reaction).emoji } : {}),
    ...(message.to ? { to: addressee(message, caller, names) } : {}),
    ...(taggedOf(message, caller) ? { tagged: taggedOf(message, caller, names) } : {}),
    ...(message.board_request === true ? { board_request: true as const } : {}),
    ...(inboxViewingLine(message) ? { viewing: inboxViewingLine(message) } : {}),
    ...(inboxSentFromLine(message) ? { sent_from: inboxSentFromLine(message) } : {}),
    ...(message.review_anchor ? { review_comment: reviewCommentLine(message) } : {}),
    ...(carriesOf(message).length > 0 ? { carries: carriesOf(message) } : {}),
  };
}

const CARRIED_SECTIONS = new Map([
  [`## ${INBOX_ACTIONS_HEADING}`, "action items"],
  [`# ${INBOX_MESSAGE_FEEDBACK_TITLE}`, "feedback on your messages"],
  [`# ${INBOX_OWN_MESSAGE_FEEDBACK_TITLE}`, "feedback on the person's messages"],
  [`# ${INBOX_ATTACHMENT_FEEDBACK_TITLE}`, "feedback on the attached files"],
  [`# ${INBOX_GUIDE_FEEDBACK_TITLE}`, "feedback on the guided review"],
  ["# Feedback on your running app", "feedback on your running app"],
]);

/** The sections a person's reply carries after its words, as a Send appends them (each heading after a blank line). */
function carriesOf(message: InboxMessageWire): string[] {
  if (message.author.kind !== "person") return [];
  const lines = message.body.split("\n");
  const found = new Set<string>();
  let fenced = false;
  for (const [at, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const name = !fenced && at > 0 && lines[at - 1] === "" ? CARRIED_SECTIONS.get(line.trimEnd()) : undefined;
    if (name) found.add(name);
  }
  return [...found];
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
  // A Tidy run whose wake to a session was withdrawn (steps turned off, only steps listed) asked it nothing: its notes are left out.
  const withdrawn = thread.messages.some((m) => m.tidy)
    ? new Set(store.tidyNotes().filter((m) => m.tidy?.wake && m.to && m.delivery?.host === INBOX_TIDY_WITHDRAWN_HOST).map((m) => `${m.tidy!.id}|${m.to!.session}`))
    : null;
  const kept = withdrawn && withdrawn.size > 0 ? thread.messages.filter((m) => !(m.tidy && m.to && withdrawn.has(`${m.tidy.id}|${m.to.session}`))) : thread.messages;
  const { farReader } = input;
  const listed = farReader ? kept.map((m) => inboxMessageForReader(m, farReader)) : kept;
  const all = listed.map((message) => {
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
  // The person's newest message is shown as sent, whatever its size, and never folded into a line.
  const personNewest = [...inRange].reverse().find((m) => m.author.kind === "person" && !isInboxNote(m));
  if (personNewest) full.add(personNewest.id);

  const caller = input.caller ?? null;
  const checked = store.message(threadId)?.agent_checked_seq ?? 0;
  const byId = new Map(all.map((m) => [m.id, m]));
  // A message of the person's this reader is owed and has not had: with a session, exactly what its wake would
  // deliver (`owedTo`, Inbox notes included; never a review comment after its batch's lead, a reply to another
  // session or to the person's own message); without one, a reply to a message sent without a session.
  const owedHere = (m: InboxMessageWire): boolean => {
    const stored = store.message(m.id);
    if (!stored || stored.author.kind !== "person") return false;
    if (caller) return store.owedTo(stored, caller);
    if (stored.delivery || stored.to || seq.get(m.id)! <= checked || (stored.review_batch && !stored.review_batch.lead)) return false;
    const asked = stored.reply_to ? byId.get(stored.reply_to) : undefined;
    return asked?.author.kind === "agent" && !asked.author.session;
  };
  const rest = inRange.filter((m) => !full.has(m.id));
  const recent = new Set(rest.slice(-INBOX_THREAD_LINES).map((m) => m.id));
  // The reader's unread replies past the recent lines are listed too, the oldest first, so one read settles them.
  const unread = all.filter((m) => !full.has(m.id) && !recent.has(m.id) && (before === null || seq.get(m.id)! < before) && owedHere(m));
  const surfaced = new Set(unread.slice(0, INBOX_UNREAD_LINES).map((m) => m.id));
  const lined = all.filter((m) => recent.has(m.id) || surfaced.has(m.id));
  const older = new Set(rest.filter((m) => !recent.has(m.id) && !surfaced.has(m.id)).map((m) => m.id));
  const shown = new Set(inRange.filter((m) => !older.has(m.id)).map((m) => m.id));
  for (const id of [...full, ...surfaced]) shown.add(id);
  // A Re-ask note whose questions still wait is the agent's to act on: shown as sent until each is replaced, dropped or answered.
  const waiting = new Set(all.flatMap((m) => (m.questions ?? []).filter((q) => q.state === "open" || q.state === "picked").map((q) => `${m.id}/${q.key}`)));
  const pending = (m: InboxMessageWire) => (m.reask ?? []).some((ref) => waiting.has(ref));
  const settled = (m: InboxMessageWire) => (m.reask?.length ?? 0) > 0 && !pending(m);
  const notHad = (m: InboxMessageWire) => m.author.kind === "person" && !m.delivery && seq.get(m.id)! > checked;
  const formOf = (m: InboxMessageWire): AgentMessageForm => (expand.has(m.id) || m.id === personNewest?.id || pending(m) ? "whole" : notHad(m) ? "unfolded" : "window");
  // A Board request in full names the cards that link the thread already (review of #2249: no second card on a re-read).
  // Only cards still in flight: a card in Done is finished (new work in the thread gets a new card), and the card
  // list op hides done and dropped cards by default, so the agent's list agrees with this line.
  const linkedCards = () =>
    store
      .listCards({ projectIds: new Set([thread.project.id]) })
      .filter((card) => card.column !== "dropped" && card.column !== "done" && card.threads.includes(threadId))
      .map((card) => ({ id: card.id, title: card.title }));
  const messages = all
    .filter((m) => full.has(m.id))
    .map((m) => agentMessage(m, formOf(m), caller, input.names, input.filesOf, settled(m)))
    .map((m) => (m.board_request ? { ...m, board_cards: linkedCards() } : m));
  const earlier = lined.map((m) => ({ ...agentMessageLine(m, caller, input.names), ...(surfaced.has(m.id) ? { unread: true as const } : {}) }));
  const leftOut = all.filter((m) => !shown.has(m.id) && !older.has(m.id));
  // The questions of messages left out, without repeating what the reader has:
  // open and picked ones are in the header; for a message older than `after`
  // only a question whose state changed since (a pick, an answer, a
  // replacement, a Mark read, the archive), so a read of what is new stays
  // small however long the thread; for a message newer than `before`, none
  // (a read without `before` shows them, and paging back stays small).
  const archived = store.archiveSeq(threadId);
  const changedSince = (q: InboxQuestion, messageId: string): boolean =>
    after !== null && ((store.questionLineSeq(`${messageId}/${q.key}`) ?? 0) > after || (q.state === "closed" && archived !== null && archived > after));
  const elsewhere = leftOut.flatMap((m) => {
    const n = numbering(m.questions ?? []);
    if (after === null || seq.get(m.id)! > after) return [];
    return (m.questions ?? [])
      .filter((q) => q.state !== "open" && q.state !== "picked" && changedSince(q, m.id))
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

  const participants = new Map<string, { kind: "person" | "agent"; name: string; messages: number; you?: true }>();
  for (const message of all) {
    const author = agentAuthor(message.author, caller);
    const name = authorName(author);
    const you = author.kind === "agent" && author.you === true;
    const entry = participants.get(`${author.kind}:${name}`) ?? { kind: author.kind, name: author.kind === "agent" ? author.name : name, messages: 0, ...(you ? { you: true as const } : {}) };
    entry.messages += 1;
    participants.set(`${author.kind}:${name}`, entry);
  }

  const movedTo = thread.resolved_at ? (store.message(thread.thread_id)?.moved_to ?? null) : null;
  const result: ThreadWindowResult = {
    thread: {
      thread_id: thread.thread_id,
      subject: thread.subject,
      thread_name: thread.thread_name,
      resolved_at: thread.resolved_at,
      ...(movedTo ? { moved_to: movedTo } : {}),
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
      expanded: [...expand].filter((id) => !newest.has(id)).length,
      ...(unread.length > surfaced.size ? { unread_left_out: unread.length - surfaced.size } : {}),
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
    },
    cursor: store.cursor(),
    url,
  };
  const lineIds = new Set(earlier.map((line) => line.id));
  const order = all.filter((m) => full.has(m.id) || lineIds.has(m.id)).map((m) => m.id);
  // What the read may mark read: up to `before`, and never past a message this
  // reader is owed and was not shown (in full or as one line; the rule that
  // lists it), so it still wakes its session and stays unread; and the acks
  // of the messages it showed (an ack on a message left out is not seen).
  const shownIds = new Set(order);
  const unshown = all.filter((m) => !shownIds.has(m.id) && owedHere(m)).map((m) => seq.get(m.id)!);
  const stop = unshown.length > 0 ? Math.min(...unshown) - 1 : Number.POSITIVE_INFINITY;
  return { result, order, shown: shownIds, readThrough: Math.min(stop, before === null ? Number.POSITIVE_INFINITY : before - 1) };
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
  /** More than one agent wrote in the thread: a reply's feedback is on "an agent's messages", not "your messages". */
  manyAgents?: boolean;
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

/**
 * One message as one line of text, at most INBOX_LINE_MAX_CHARS where it can
 * be: its first words are clipped first (to no fewer than INBOX_LINE_MIN_WORDS
 * characters), then its questions lose their prompts and answers, then they read `N questions: key state, …`. A question
 * key and what follows (files, guided review, 👍, Board request) are never cut.
 */
export function messageLineText(line: AgentMessageLine, context: TranscriptContext): string {
  const head = [`- ${line.id}`, authorName(line.author), ...whenAndWhat(line, context)];
  if (line.unread) head.push("unread");
  const to = addresseeWords(line.to);
  if (to) head.push(to);
  const tagged = taggedWords(line.tagged);
  if (tagged) head.push(tagged);
  const mid: string[] = [];
  const carries = line.carries?.map((name) => (context.manyAgents && name === "feedback on your messages" ? "feedback on an agent's messages" : name));
  if (carries?.length) mid.push(`with ${carries.join(", ")} (expand shows them)`);
  if (line.viewing) mid.push(line.viewing);
  if (line.sent_from) mid.push(line.sent_from);
  if (line.review_comment) mid.push(line.review_comment);
  const tail: string[] = [];
  if (line.attachments?.length) tail.push(`files: ${line.attachments.join(", ")}`);
  if (line.guide) tail.push(`guided review: ${line.guide}`);
  if (line.ack) tail.push(line.reaction ?? "👍");
  // Shown in full only: the line says it is there, so a reader that sees just the line expands it.
  if (line.board_request) tail.push(`Board request (read_thread expand: ["${line.id}"] shows it)`);
  const questions = line.questions ?? [];
  const pointer = `(read_thread expand: ["${line.id}"] shows them in full)`;
  const forms: (string | null)[] = questions.length === 0
    ? [null]
    : [
        questions.map((q) => questionWords(q, true)).join("; "),
        `${questions.map((q) => questionWords({ ...q, prompt: undefined, answer: undefined, result: undefined })).join("; ")} ${pointer}`,
        `${questions.length} questions: ${questions.map((q) => `${q.key} ${q.state}`).join(", ")} ${pointer}`,
      ];
  const build = (words: string, qs: string | null) => [...head, `"${words}" (${sizeText(line.bytes)})`, ...mid, ...(qs === null ? [] : [qs]), ...tail].join(" · ");
  if (build(line.words, forms[0]!).length <= INBOX_LINE_MAX_CHARS) return build(line.words, forms[0]!);
  for (const qs of forms) {
    const room = INBOX_LINE_MAX_CHARS - build("", qs).length;
    if (room >= Math.min(INBOX_LINE_MIN_WORDS, line.words.length)) return build(clip(line.words, room), qs);
  }
  const room = INBOX_LINE_MAX_CHARS - build("", forms.at(-1)!).length;
  return build(room >= 1 ? clip(line.words, room) : "…", forms.at(-1)!);
}

/**
 * The person's reaction as an agent reads it (approval "inbox-reaction-tray"): `{ emoji, label? }`, 👍 Looks good
 * for an ack with none (an older one, or 👍 itself).
 */
function agentReaction(value: unknown): { emoji: string; label?: string } {
  const { emoji, label } = inboxAckReaction(value);
  return label ? { emoji, label } : { emoji };
}

/** The line under a message the person reacted to: the emoji, its name when it has one, and when. */
function ackLineText(ack: NonNullable<AgentMessage["ack"]>): string {
  const { emoji, label } = inboxAckReaction(ack.reaction);
  return `${emoji}${label ? ` ${label}` : ""} (${shortTime(ack.at)}): the person's reaction.`;
}

/** One message in full as text: a heading line, the body, then its questions, files, guide and 👍. */
export function messageText(message: AgentMessage, context: TranscriptContext): string {
  const head = [message.id, authorName(message.author), ...whenAndWhat(message, context)];
  const to = addresseeWords(message.to);
  if (to) head.push(to);
  const tagged = taggedWords(message.tagged);
  if (tagged) head.push(tagged);
  const lines = [`[${head.join(" · ")}]`, message.body.trimEnd()];
  if (message.viewing) lines.push(message.viewing);
  if (message.sent_from) lines.push(message.sent_from);
  if (message.review_comment) lines.push(message.review_comment);
  if (message.questions?.length) lines.push(`Questions: ${message.questions.map((q) => questionWords(q)).join("; ")}`);
  if (message.files?.length) lines.push(`Files: ${message.files.map((f) => `${f.name} (${f.kind}, ${sizeText(f.size)}): ${f.path} (to your machine: ${f.fetch})`).join("; ")}`);
  if (message.attachments?.length) {
    lines.push(`Files: ${message.attachments.map((a) => `${a.name} (${a.kind}, ${sizeText(a.size)}): ${a.path}`).join("; ")}`);
  }
  if (message.guide) lines.push(`Guided review: ${message.guide.title}`);
  if (message.ack) lines.push(ackLineText(message.ack));
  // Compose's Board chip: the request, once, after the words and files (the wake's order), and the cards
  // that link the thread already, so a second reader keeps those current instead of making more.
  if (message.board_request) {
    lines.push("", inboxBoardRequestBlock(message.id));
    if (message.board_cards?.length) {
      lines.push(`Already on the Board for this thread: ${message.board_cards.map((c) => `${c.id} (${c.title})`).join("; ")}. Keep ${message.board_cards.length === 1 ? "it" : "them"} current; make no other.`);
    }
  }
  if (message.decision_ask) lines.push("", INBOX_DECISION_ASK_BLOCK);
  if (message.rows_ask) lines.push("", INBOX_ROWS_ASK_BLOCK);
  return lines.join("\n");
}

/** The whole windowed read as text: complete for an agent (the JSON adds nothing it needs). */
export function windowedThreadText(result: ThreadWindowResult, order: readonly string[], extra = "", steps: readonly string[] = []): string {
  const { thread, window } = result;
  const persons = thread.participants.filter((p) => p.kind === "person").reduce((sum, p) => sum + p.messages, 0);
  const out: string[] = [];
  out.push(
    `Thread ${thread.thread_id}${thread.subject ? ` (${thread.subject})` : ""}: ${thread.message_count} message${thread.message_count === 1 ? "" : "s"}, ${persons} from the person${thread.resolved_at ? ", resolved" : ""}.`,
  );
  const facts = [
    thread.thread_name ? `Name: ${thread.thread_name}` : null,
    `Project: ${thread.project.name} (${thread.project.root})`,
    `From: ${thread.participants.map((p) => `${p.you ? `${p.name} (you)` : p.name} ${p.messages}`).join(", ")}`,
    thread.resolved_at ? `Resolved ${shortTime(thread.resolved_at)}` : null,
    thread.moved_to ? `Its questions moved to thread ${thread.moved_to.thread_id}${thread.moved_to.subject ? ` (${thread.moved_to.subject})` : ""}` : null,
    result.url,
  ].filter((part): part is string => part !== null);
  out.push(facts.join(" · "));
  const withChoices = thread.open_questions.reduce((sum, q) => sum + q.choices.join(" | ").length, 0) <= INBOX_HEADER_CHOICES_CHARS;
  const older = thread.message_count - window.full - window.lines - window.left_out;
  const personNewest = window.full - window.newest - window.expanded > 0;
  if (thread.open_questions.length === 0) {
    out.push("No question waits on the person.");
  } else {
    const actions = thread.open_questions.filter((q) => q.key.startsWith("a-")).length;
    const questions = thread.open_questions.length - actions;
    const each = (n: number, noun: string) => (n > 0 ? [`${n} ${noun}${n === 1 ? "" : "s"}`] : []);
    out.push(`Waiting on the person (${[...each(questions, "question"), ...each(actions, "action item")].join(", ")}):`);
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
      const choices = q.choices.length === 0 ? "" : withChoices || q.file ? ` Choices: ${q.choices.map((c) => clip(c, 200)).join(" | ")}` : ` (${q.choices.length} choices; read_thread expand: ["${q.message_id}"] shows them)`;
      out.push(`- ${q.message_id}/${q.key} (${todo ? "A" : "Q"}${q.q}${q.file ? ` in your file ${q.file}` : ""}) ${state}: ${clip(q.prompt, INBOX_HEADER_PROMPT_CHARS)}${choices}`);
    }
  }
  if (thread.questions?.length) {
    out.push(`Questions of messages not shown: ${thread.questions.map((q) => `${q.message_id}/${questionWords(q, true)}`).join("; ")}`);
  }
  // Thread steps (approval "inbox-thread-steps"): given only while the person has them on.
  out.push(...steps);
  const range = window.after !== undefined || window.before !== undefined
    ? ` Range:${window.after !== undefined ? ` after ${window.after}` : ""}${window.before !== undefined ? ` before ${window.before}` : ""}; ${window.left_out} other message${window.left_out === 1 ? "" : "s"} left out.`
    : "";
  out.push(
    `Shown: ${window.full} in full (the newest ${window.newest}${personNewest ? ", the person's newest" : ""}${window.expanded > 0 ? `, ${window.expanded} expanded` : ""}) and ${window.lines} earlier as one line each.${range} A message replies to the one above it unless it says otherwise; times are UTC. read_thread expand: [ids] shows messages in full; before: <id> reads further back; after: <cursor> returns only what is new.`,
  );
  out.push("");
  const firstLine = thread.earlier[0]?.id;
  const listed = thread.earlier.filter((line) => line.unread);
  const firstRecent = thread.earlier.find((line) => !line.unread)?.id ?? firstLine;
  const afterWords = window.after !== undefined ? ` after ${window.after} and` : ",";
  const readCall = (from: string | number | undefined, to: string | undefined) => `read_thread ${from !== undefined ? `after: ${from}, ` : ""}before: ${to}`;
  const countLine = [
    `… ${older} more message${older === 1 ? "" : "s"}${afterWords} older than the ${listed.length > 0 ? "recent lines" : "line"} below, not shown here (${readCall(window.after, firstRecent)} reads them)`,
    ...(listed.length > 0 ? [`; first, the person's ${listed.length} unread repl${listed.length === 1 ? "y" : "ies"} among the older ones`] : []),
    ...(window.unread_left_out ? [`; ${window.unread_left_out} more unread repl${window.unread_left_out === 1 ? "y is" : "ies are"} among the ones not shown (${readCall(listed.at(-1)?.id, firstRecent)} reads them)`] : []),
  ].join("");
  // Oldest first, one line or in full.
  const lines = new Map(thread.earlier.map((line) => [line.id, line]));
  const fulls = new Map(thread.messages.map((message) => [message.id, message]));
  const context: TranscriptContext = { previousId: null, previousDate: null, rootId: thread.thread_id, manyAgents: thread.participants.filter((p) => p.kind === "agent").length > 1 };
  let previousWasLine = false;
  for (const id of order) {
    const line = lines.get(id);
    if (line) {
      if (id === firstLine && (older > 0 || window.unread_left_out)) out.push(countLine);
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
