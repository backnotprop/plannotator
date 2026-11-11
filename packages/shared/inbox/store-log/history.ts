/**
 * Facts that depend on the ORDER of lines. One copy of each rule, shared by the store's replay and the SQLite log's
 * write path, which must agree.
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

/** `before`: the previous line's `resolved_at`; `had`: the archive seq known before. Null: open. */
export function archiveSeqAfter(before: string | null | undefined, had: number | null, next: InboxMessage, seq: number): number | null {
  if (next.resolved_at == null) return null;
  return before !== next.resolved_at || had === null ? seq : had;
}

export function movesAddress(prev: InboxMessage | undefined, next: InboxMessage): boolean {
  return !!prev && !!next.started_by_person && !!prev.to && !!next.to && prev.to.session !== next.to.session;
}

export function agentNamesHere(prev: InboxMessage | undefined, next: InboxMessage): boolean {
  return !!prev && !!next.started_by_person && !!next.thread_name && next.named_by?.kind === "agent" && prev.named_by?.kind !== "agent";
}

/** An agent's thread routes by its name; a thread the person started only keeps another from taking it (`routes: false`). */
export function firstLineName(first: InboxMessage): { name: string; routes: boolean } | null {
  if (first.thread_id !== first.id) return null;
  if (first.author.kind !== "agent") return first.started_by_person && first.thread_name ? { name: first.thread_name, routes: false } : null;
  return first.thread_name != null ? { name: first.thread_name, routes: true } : null;
}

export function threadNameIndexKey(projectId: string, name: string): string {
  return `${projectId}\0${inboxThreadNameKey(name)}`;
}

const TAG_START = /#[\p{L}\p{N}]/u;

/** Each key once. */
export function firstLineTagKeys(first: InboxMessage): string[] {
  // The parser is costly on every message: skipped when no tag can start.
  if (typeof first.body !== "string" || !TAG_START.test(first.body)) return [];
  return [...new Set(inboxHashtags(first.body).map((tag) => tag.key))].filter((key) => !!key);
}

/** `done_prs` and `initiative` carry over from `prev` when an older line left them out. `heard`: a real change (a drop's seen mark is not). */
export function cardAfter(prev: InboxCard | undefined, raw: InboxCard): { card: InboxCard; heard: boolean } {
  let card = readInboxCard(raw);
  if (card.column === "done") card = { ...card, done_prs: inboxCardDonePrs(card, card.done_prs ?? prev?.done_prs) };
  else if (card.done_prs === undefined && prev?.done_prs) card = { ...card, done_prs: prev.done_prs };
  if (raw.initiative === undefined && prev?.initiative) card = { ...card, initiative: prev.initiative };
  return { card, heard: !prev || !isInboxCardSeenOnlyChange(prev, card) };
}

/** Null for a state line, which is no event. */
export function pullEventOf(prev: InboxThreadPull | undefined, record: InboxThreadPull, seq: number): InboxThreadPullEvent | null {
  const live = record.removed_at === undefined;
  const wasLive = prev ? prev.removed_at === undefined : false;
  if (prev && live === wasLive && (!live || prev.added_at === record.added_at)) return null;
  return live
    ? { seq, at: record.added_at, op: "add", pull: record.pull, by: record.added_by }
    : { seq, at: record.removed_at!, op: "remove", pull: record.pull, by: record.removed_by! };
}

/** Only the typed words, revision and pick time moved, and neither line a Send: the SQLite log writes it over the one before. */
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
