/**
 * The facts the store reads from the ORDER of its lines, not from any one record: when a thread was archived,
 * whether its address moved, where a name started routing, a message's first-line hashtags, a card's last real
 * change and the card as the Board reads it, a PR add or remove. One copy of each rule, used twice:
 *
 * - the store's replay of every line (`InboxStore.apply`, today's JSONL log), and
 * - the SQLite log, which works each fact out as its line is written and keeps it in a column or a row, so a
 *   start reads current state from the tables instead of replaying history (`sqlite/write-line.ts`).
 *
 * Each function takes the record's previous line (what the store held before this one) and the new one.
 */
import {
  inboxCardDonePrs,
  inboxHashtags,
  inboxThreadNameKey,
  isInboxCardSeenOnlyChange,
  readInboxCard,
  type InboxCard,
  type InboxMessage,
  type InboxQuestionRecord,
  type InboxThreadPull,
} from "@plannotator/core/inbox-types";
import type { InboxThreadPullEvent } from "../store";

/**
 * A resolved message's archive line after `next` (written at `seq`): the line whose `resolved_at` differs from
 * the one before it. `before`: the previous line's `resolved_at`; `had`: the archive seq known before. Null: open.
 */
export function archiveSeqAfter(before: string | null | undefined, had: number | null, next: InboxMessage, seq: number): number | null {
  if (next.resolved_at == null) return null;
  return before !== next.resolved_at || had === null ? seq : had;
}

/** "Send to another session" moved a thread the person started: a later root line names another `to.session`. */
export function movesAddress(prev: InboxMessage | undefined, next: InboxMessage): boolean {
  return !!prev && !!next.started_by_person && !!prev.to && !!next.to && prev.to.session !== next.to.session;
}

/** An agent named a thread the person started, at this line: from here on the name routes (`sendMessage`). */
export function agentNamesHere(prev: InboxMessage | undefined, next: InboxMessage): boolean {
  return !!prev && !!next.started_by_person && !!next.thread_name && next.named_by?.kind === "agent" && prev.named_by?.kind !== "agent";
}

/**
 * The name a root's FIRST line gives it, or null: an agent's thread routes by it; a thread the person started
 * only keeps another open thread from taking it (`routes: false`).
 */
export function firstLineName(first: InboxMessage): { name: string; routes: boolean } | null {
  if (first.thread_id !== first.id) return null;
  if (first.author.kind !== "agent") return first.started_by_person && first.thread_name ? { name: first.thread_name, routes: false } : null;
  return first.thread_name != null ? { name: first.thread_name, routes: true } : null;
}

/** The routing key a name is kept under: one per project folder. */
export function threadNameIndexKey(projectId: string, name: string): string {
  return `${projectId}\0${inboxThreadNameKey(name)}`;
}

/** A `#` and then a letter or digit: every hashtag starts so, and most bodies (a `## heading` is none) have none. */
const TAG_START = /#[\p{L}\p{N}]/u;

/** The hashtag keys a message's FIRST line carries (the Board's `#` tags), each once. */
export function firstLineTagKeys(first: InboxMessage): string[] {
  // The parser blanks code and links before it looks, which costs on every message: skipped when no tag can start.
  if (typeof first.body !== "string" || !TAG_START.test(first.body)) return [];
  return [...new Set(inboxHashtags(first.body).map((tag) => tag.key))].filter((key) => !!key);
}

/**
 * A card line as the Board reads it, given the card it read before (`prev`): old shapes in today's columns, a card
 * in Done holding every PR it links, `done_prs` and `initiative` kept from before when an older Inbox left them
 * out. `heard`: the line is a real change (a drop's seen mark is not), so the card's unread seq moves to it.
 */
export function cardAfter(prev: InboxCard | undefined, raw: InboxCard): { card: InboxCard; heard: boolean } {
  let card = readInboxCard(raw);
  if (card.column === "done") card = { ...card, done_prs: inboxCardDonePrs(card, card.done_prs ?? prev?.done_prs) };
  else if (card.done_prs === undefined && prev?.done_prs) card = { ...card, done_prs: prev.done_prs };
  if (raw.initiative === undefined && prev?.initiative) card = { ...card, initiative: prev.initiative };
  return { card, heard: !prev || !isInboxCardSeenOnlyChange(prev, card) };
}

/** The PR event a thread-pull line is (an add, a remove, a re-add), or null for a state line, which is no event. */
export function pullEventOf(prev: InboxThreadPull | undefined, record: InboxThreadPull, seq: number): InboxThreadPullEvent | null {
  const live = record.removed_at === undefined;
  const wasLive = prev ? prev.removed_at === undefined : false;
  if (prev && live === wasLive && (!live || prev.added_at === record.added_at)) return null;
  return live
    ? { seq, at: record.added_at, op: "add", pull: record.pull, by: record.added_by }
    : { seq, at: record.removed_at!, op: "remove", pull: record.pull, by: record.removed_by! };
}

/**
 * A question line that only carries on typing over the line before it: the same pick, the same state, only the
 * typed words (`text`, `other`, `note`), the revision and the pick time moved, and neither line a Send. The
 * decision history keeps one row per change of choice, Send, replacement, set-aside or Undo, never one per key, so
 * the SQLite log writes such a line over the one before it.
 */
export function continuesTyping(prev: InboxQuestionRecord, next: InboxQuestionRecord): boolean {
  if (!prev.answer || !next.answer) return false;
  if (sentNow(prev) || sentNow(next)) return false;
  return JSON.stringify(withoutTyping(prev)) === JSON.stringify(withoutTyping(next));
}

const sentNow = (q: InboxQuestionRecord) => q.sent_reply_id !== null && q.sent_revision === q.revision;

function withoutTyping(q: InboxQuestionRecord): unknown {
  const { revision: _r, picked_at: _p, answer, ...rest } = q;
  const { text: _t, other: _o, note: _n, ...choice } = answer!;
  return { ...rest, answer: choice };
}
