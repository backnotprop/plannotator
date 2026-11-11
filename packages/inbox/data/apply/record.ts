/**
 * One live-stream record applied to a thread the window holds, in place (pure: no cache, no React).
 *
 * The stream's `record` frame carries the stored message or question whole, so most records change a held thread
 * with no read. What only a thread read gives, and how it is handled here:
 *  - a message's `seq` (its first line's): the record's own seq when `first`; a later line (a look, an archive, a
 *    rename, a delivery) keeps the seq it had;
 *  - its questions: separate `question` records, merged in by key (a revision only grows), action items split out
 *    as `inboxApi.thread` does;
 *  - a reply's comment count (`sent_annotations`) and a 👍's delivery: in no record; a record that can change them
 *    asks for a read (`reread`), and so does a subject change (the server works the subject out) and the note that
 *    carries a 👍 (the read hides it);
 *  - the thread's own fields (archived, its name, the archive's seq): from a later line of the root message.
 *
 * `applied` remembers the seq of each line applied (by message id), so a read that left before a record and lands
 * after it never takes the record back (`reconcileRead`).
 */
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { InboxEvent, ThreadModel } from '../../api';
import { splitMessageActions } from '../../actions';

/** A thread as the cache holds it: its read, and the seq of each line applied since (by message id). */
export type HeldThread = ThreadModel & { applied?: Readonly<Record<string, number>> };

export type RecordOutcome = { kind: 'none' } | { kind: 'applied'; model: HeldThread } | { kind: 'reread' };

const NONE: RecordOutcome = { kind: 'none' };
const REREAD: RecordOutcome = { kind: 'reread' };

/** The note that carries a 👍 to the agent: the thread read leaves it out (the ack on its message says it). */
const isAckNote = (m: { author: { kind: string }; ack_of?: string | null }) => m.author.kind === 'person' && typeof m.ack_of === 'string' && m.ack_of !== '';

/** A question put into its message by key (replaced in place, or added at the end), action items split out again. */
export function withQuestion(message: InboxMessageWire, question: InboxQuestion): InboxMessageWire {
  const all = [...(message.questions ?? []), ...(message.actions ?? [])];
  const at = all.findIndex((q) => q.key === question.key);
  if (at >= 0 && all[at]!.revision > question.revision) return message;
  if (at >= 0) all[at] = question;
  else all.push(question);
  const { actions: _actions, questions: _questions, ...rest } = message;
  return splitMessageActions({ ...rest, questions: all });
}

const withApplied = (model: HeldThread, id: string, seq: number): Readonly<Record<string, number>> => ({ ...model.applied, [id]: Math.max(seq, model.applied?.[id] ?? 0) });

/** The answers a save of this window brought back (whole, for their message), on the thread held. */
export function withSavedQuestions(model: HeldThread, messageId: string, questions: readonly InboxQuestion[]): HeldThread {
  const messages = model.thread.messages.map((m) => (m.id === messageId ? questions.reduce(withQuestion, m) : m));
  return { ...model, thread: { ...model.thread, messages } };
}

/** What one stream record does to the thread held. Records of other threads, and kinds a thread does not show, do nothing. */
export function applyRecord(model: HeldThread, event: InboxEvent): RecordOutcome {
  const thread = model.thread;
  // The read already has every record up to its cursor: a replay of one (a reconnect resumes from the last seq it
  // saw) would only put an older line back.
  if ((event.kind === 'message' || event.kind === 'question') && event.seq <= model.cursor) return NONE;
  if (event.kind === 'message') {
    const record = event.message;
    if (record.thread_id !== thread.thread_id) return NONE;
    if (isAckNote(record)) return REREAD;
    const at = thread.messages.findIndex((m) => m.id === record.id);
    const before = at >= 0 ? thread.messages[at]! : undefined;
    // Applied already: a replay changes nothing.
    if ((model.applied?.[record.id] ?? -1) >= event.seq) return NONE;
    // A 👍 given, changed or taken back: its delivery and its note come only with a read.
    if ((record.ack?.at ?? null) !== (before?.ack?.at ?? null) || (record.ack && before?.ack && record.ack.reaction !== before.ack.reaction)) {
      if (record.ack || before?.ack) return REREAD;
    }
    // A later line of the root with another subject: the server works the subject out, so it is read.
    if (record.id === thread.thread_id && before && (record.subject ?? null) !== (before.subject ?? null)) return REREAD;
    const seq = before?.seq ?? (event.first ? event.seq : undefined);
    const next: InboxMessageWire = {
      ...record,
      ...(before?.questions ? { questions: before.questions } : {}),
      ...(before?.actions ? { actions: before.actions } : {}),
      ...(seq === undefined ? {} : { seq }),
      ...(record.author.kind === 'person' ? { sent_annotations: before?.sent_annotations ?? 0 } : {}),
      ...(before?.ack && record.ack ? { ack: before.ack } : {}),
    };
    // A new message goes after every message with a lower seq (the read's order), else at the end.
    const messages = [...thread.messages];
    if (before) messages[at] = next;
    else {
      const after = seq === undefined ? -1 : messages.findIndex((m) => (m.seq ?? -1) > seq);
      messages.splice(after < 0 ? messages.length : after, 0, next);
    }
    let head = thread;
    if (record.id === thread.thread_id && before) {
      const archived = record.resolved_at !== null && thread.resolved_at === null;
      head = {
        ...thread,
        resolved_at: record.resolved_at,
        thread_name: record.thread_name ?? null,
        archive_seq: archived ? event.seq : record.resolved_at === null ? null : (thread.archive_seq ?? null),
      };
    }
    return { kind: 'applied', model: { ...model, thread: { ...head, messages }, applied: withApplied(model, record.id, event.seq) } };
  }
  if (event.kind === 'question') {
    if (event.thread_id !== thread.thread_id) return NONE;
    const at = thread.messages.findIndex((m) => m.id === event.question.message_id);
    if (at < 0) return REREAD;
    const message = thread.messages[at]!;
    const next = withQuestion(message, event.question);
    if (next === message) return NONE;
    const messages = [...thread.messages];
    messages[at] = next;
    return { kind: 'applied', model: { ...model, thread: { ...thread, messages }, applied: withApplied(model, `${message.id}/${event.question.key}`, event.seq) } };
  }
  if (event.kind === 'annotation') {
    // A comment that went with a reply moves that reply's count, which only a read gives. Other comments live with
    // the thread's files, which the window reads apart.
    const record = event.annotation;
    if (record.thread_id === thread.thread_id && record.sent_reply_id && thread.messages.some((m) => m.id === record.sent_reply_id)) return REREAD;
  }
  return NONE;
}

/**
 * A read of the thread as the cache keeps it. A read reflects every record up to its `cursor`; a line applied
 * after that (its record came while the read was out) is newer than the read, so it stays: a message the read does
 * not have yet, a message's later line, a question's newer revision, the root's own fields.
 */
export function reconcileRead(held: HeldThread | undefined, read: ThreadModel): HeldThread {
  const applied = held?.applied;
  if (!held || !applied || held.thread.thread_id !== read.thread.thread_id) return read;
  const newer = Object.entries(applied).filter(([, seq]) => seq > read.cursor);
  if (newer.length === 0) return read;
  const keep = new Map(newer);
  const heldById = new Map(held.thread.messages.map((m) => [m.id, m] as const));
  const readIds = new Set(read.thread.messages.map((m) => m.id));
  let messages = read.thread.messages.map((m) => {
    const mine = heldById.get(m.id);
    if (!mine) return m;
    let out = keep.has(m.id) ? { ...mine, questions: m.questions, actions: m.actions } : m;
    // Questions applied after the read keep their newer revision.
    for (const q of [...(mine.questions ?? []), ...(mine.actions ?? [])]) if (keep.has(`${m.id}/${q.key}`)) out = withQuestion(out, q);
    return out;
  });
  for (const m of held.thread.messages) if (!readIds.has(m.id) && keep.has(m.id)) messages = [...messages, m];
  const root = keep.has(read.thread.thread_id) ? { resolved_at: held.thread.resolved_at, thread_name: held.thread.thread_name, archive_seq: held.thread.archive_seq } : {};
  return { ...read, thread: { ...read.thread, ...root, messages }, applied: Object.fromEntries(newer) };
}
