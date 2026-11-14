import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { InboxEvent, ThreadModel } from '../../api';
import { splitMessageActions } from '../../actions';

export type HeldThread = ThreadModel & { applied?: Readonly<Record<string, number>>; sentWith?: Readonly<Record<string, number>>; saved?: Readonly<Record<string, number>> };

export type RecordOutcome = { kind: 'none' } | { kind: 'applied'; model: HeldThread } | { kind: 'reread' };

const NONE: RecordOutcome = { kind: 'none' };
const REREAD: RecordOutcome = { kind: 'reread' };

const isAckNote = (m: { author: { kind: string }; ack_of?: string | null }) => m.author.kind === 'person' && typeof m.ack_of === 'string' && m.ack_of !== '';

export function withQuestion(message: InboxMessageWire, question: InboxQuestion): InboxMessageWire {
  const all = [...(message.questions ?? []), ...(message.actions ?? [])];
  const at = all.findIndex((q) => q.key === question.key);
  if (at >= 0 && all[at]!.revision > question.revision) return message;
  if (at >= 0) all[at] = question;
  else all.push(question);
  const { actions: _actions, questions: _questions, ...rest } = message;
  return splitMessageActions({ ...rest, questions: all });
}

const questionsAndActions = (m: InboxMessageWire) => [...(m.questions ?? []), ...(m.actions ?? [])];
const hasClosedQuestion = (m: InboxMessageWire) => questionsAndActions(m).some((q) => q.state === 'closed');
const closeQuestion = (q: InboxQuestion): InboxQuestion => (q.state === 'superseded' || q.state === 'closed' ? q : { ...q, state: 'closed' });

function closedByArchive(message: InboxMessageWire, archiveSeq: number): InboxMessageWire {
  if ((message.seq ?? archiveSeq) >= archiveSeq || questionsAndActions(message).every((q) => q.state === 'superseded' || q.state === 'closed')) return message;
  return { ...message, ...(message.questions ? { questions: message.questions.map(closeQuestion) } : {}), ...(message.actions ? { actions: message.actions.map(closeQuestion) } : {}) };
}

const withApplied = (model: HeldThread, id: string, seq: number): Readonly<Record<string, number>> => ({ ...model.applied, [id]: Math.max(seq, model.applied?.[id] ?? 0) });

export function withSavedQuestions(model: HeldThread, messageId: string, questions: readonly InboxQuestion[]): HeldThread {
  const messages = model.thread.messages.map((m) => (m.id === messageId ? questions.reduce(withQuestion, m) : m));
  const saved = { ...model.saved, ...Object.fromEntries(questions.map((q) => [`${messageId}/${q.key}`, q.revision])) };
  return { ...model, thread: { ...model.thread, messages }, saved };
}

export function recordMovesFiles(model: HeldThread, event: InboxEvent): boolean {
  const thread = model.thread;
  if (event.kind === 'annotation') return event.annotation.thread_id === thread.thread_id;
  if (event.kind !== 'message' || event.message.thread_id !== thread.thread_id) return false;
  const record = event.message;
  if (event.first) return (record.attachments?.length ?? 0) === 0 && (record.inline_images?.length ?? 0) === 0;
  const root = record.id === thread.thread_id ? thread.messages.find((m) => m.id === record.id) : undefined;
  return root !== undefined && (record.agent_checked_seq ?? null) !== (root.agent_checked_seq ?? null);
}

export function applyRecord(model: HeldThread, event: InboxEvent): RecordOutcome {
  const thread = model.thread;
  if ((event.kind === 'message' || event.kind === 'question') && event.seq <= model.cursor) return NONE;
  if (event.kind === 'message') {
    const record = event.message;
    if (record.thread_id !== thread.thread_id) return NONE;
    if (isAckNote(record)) return REREAD;
    const at = thread.messages.findIndex((m) => m.id === record.id);
    const before = at >= 0 ? thread.messages[at]! : undefined;
    if ((model.applied?.[record.id] ?? -1) >= event.seq) return NONE;
    if (record.taken_back_at) {
      if (record.id === thread.thread_id) return REREAD;
      if (!before) return { kind: 'applied', model: { ...model, applied: withApplied(model, record.id, event.seq) } };
      const messages = thread.messages.filter((m) => m.id !== record.id);
      return { kind: 'applied', model: { ...model, thread: { ...thread, messages }, applied: withApplied(model, record.id, event.seq) } };
    }
    if ((record.ack?.at ?? null) !== (before?.ack?.at ?? null) || (record.ack && before?.ack && record.ack.reaction !== before.ack.reaction)) {
      if (record.ack || before?.ack) return REREAD;
    }
    if (record.id === thread.thread_id && before && (record.subject ?? null) !== (before.subject ?? null)) return REREAD;
    const seq = before?.seq ?? (event.first ? event.seq : undefined);
    const next: InboxMessageWire = {
      ...record,
      ...(before?.questions ? { questions: before.questions } : {}),
      ...(before?.actions ? { actions: before.actions } : {}),
      ...(seq === undefined ? {} : { seq }),
      ...(record.author.kind === 'person' ? { sent_annotations: before?.sent_annotations ?? model.sentWith?.[record.id] ?? 0 } : {}),
      ...(before?.ack && record.ack ? { ack: before.ack } : {}),
    };
    let messages = [...thread.messages];
    if (before) messages[at] = next;
    else {
      const after = seq === undefined ? -1 : messages.findIndex((m) => (m.seq ?? -1) > seq);
      messages.splice(after < 0 ? messages.length : after, 0, next);
    }
    let head = thread;
    if (record.id === thread.thread_id && before) {
      const archived = record.resolved_at !== null && thread.resolved_at === null;
      if (record.resolved_at === null && thread.resolved_at !== null && messages.some(hasClosedQuestion)) return REREAD;
      if (archived) messages = messages.map((m) => closedByArchive(m, event.seq));
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
    const root = thread.messages.find((m) => m.id === thread.thread_id);
    const was = [...(message.questions ?? []), ...(message.actions ?? [])].find((x) => x.key === event.question.key);
    if (root && root.subject_question !== null && JSON.stringify(was?.superseded_by ?? null) !== JSON.stringify(event.question.superseded_by ?? null)) return REREAD;
    const messages = [...thread.messages];
    messages[at] = next;
    return { kind: 'applied', model: { ...model, thread: { ...thread, messages }, applied: withApplied(model, `${message.id}/${event.question.key}`, event.seq) } };
  }
  if (event.kind === 'annotation') {
    const record = event.annotation;
    if (record.thread_id === thread.thread_id && record.sent_reply_id) {
      if (thread.messages.some((m) => m.id === record.sent_reply_id)) return REREAD;
      if (event.seq <= model.cursor || model.applied?.[`ann:${event.id}`] !== undefined) return NONE;
      const reply = record.sent_reply_id;
      return { kind: 'applied', model: { ...model, sentWith: { ...model.sentWith, [reply]: (model.sentWith?.[reply] ?? 0) + 1 }, applied: withApplied(model, `ann:${event.id}`, event.seq) } };
    }
    return NONE;
  }
  switch (event.kind) {
    case 'card':
    case 'initiative':
    case 'steps':
    case 'thread_pull':
      return NONE;
    case 'project':
      return REREAD;
    default: {
      const unknown: never = event;
      void unknown;
      return REREAD;
    }
  }
}

function keepSaved(held: HeldThread, read: ThreadModel): HeldThread {
  const marks = Object.entries(held.saved ?? {});
  if (marks.length === 0) return read;
  const heldById = new Map(held.thread.messages.map((m) => [m.id, m] as const));
  const still: Record<string, number> = {};
  const messages = read.thread.messages.map((m) => {
    let out = m;
    for (const [mark, revision] of marks) {
      const [messageId, key] = mark.split('/');
      if (messageId !== m.id) continue;
      const fresh = [...(m.questions ?? []), ...(m.actions ?? [])].find((q) => q.key === key);
      if (fresh && fresh.revision >= revision) continue;
      const mine = [...(heldById.get(m.id)?.questions ?? []), ...(heldById.get(m.id)?.actions ?? [])].find((q) => q.key === key);
      if (!mine) continue;
      still[mark] = revision;
      out = withQuestion(out, mine);
    }
    return out;
  });
  return { ...read, thread: { ...read.thread, messages }, ...(Object.keys(still).length > 0 ? { saved: still } : {}) };
}

export function reconcileRead(held: HeldThread | undefined, fresh: ThreadModel): HeldThread {
  if (!held || held.thread.thread_id !== fresh.thread.thread_id) return fresh;
  const read = keepSaved(held, fresh);
  const applied = held.applied;
  if (!applied) return read;
  const newer = Object.entries(applied).filter(([, seq]) => seq > read.cursor);
  if (newer.length === 0) return read;
  const keep = new Map(newer);
  const heldById = new Map(held.thread.messages.map((m) => [m.id, m] as const));
  const readIds = new Set(read.thread.messages.map((m) => m.id));
  let messages = read.thread.messages.flatMap((m) => {
    const mine = heldById.get(m.id);
    if (!mine) return keep.has(m.id) ? [] : [m];
    let out = keep.has(m.id) ? { ...mine, questions: m.questions, actions: m.actions } : m;
    for (const q of [...(mine.questions ?? []), ...(mine.actions ?? [])]) if (keep.has(`${m.id}/${q.key}`)) out = withQuestion(out, q);
    return [out];
  });
  for (const m of held.thread.messages) if (!readIds.has(m.id) && keep.has(m.id)) messages = [...messages, m];
  const root = keep.has(read.thread.thread_id) ? { resolved_at: held.thread.resolved_at, thread_name: held.thread.thread_name, archive_seq: held.thread.archive_seq } : {};
  return { ...read, thread: { ...read.thread, ...root, messages }, applied: Object.fromEntries(newer), ...(held.sentWith ? { sentWith: held.sentWith } : {}) };
}
