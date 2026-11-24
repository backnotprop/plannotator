/**
 * Decision mode's queue, pure (approval "inbox-decision-mode-one-send", 2026-11-24): one agent MESSAGE at a time,
 * read from the thread the window already has (a linked computer's thread too), never from a projection of its own.
 *
 * A message is in the queue while it holds a decision: a question that waits on the person (open, or answered in
 * the draft) or an action item (open, or marked in the draft). Its order is fixed when the sitting starts: Stopped
 * first, then Holds up, then thread order (as before). Later moves a message to the end. Answers are the thread's
 * own drafts; nothing here saves or sends.
 */
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { inboxActionInDraft, readInboxQuestionKind } from '@plannotator/core/inbox-types';
import { inboxQuestionWaitsOnPerson, inboxUrgencyOf } from '@plannotator/core/inbox-questions';
import { isQuestionAnswerEmpty, type QuestionAnswer } from '@plannotator/core/question-block';
import { formatCount } from '../format';

/** How many decisions a message holds, and how many have an answer or a mark in the draft. */
export interface DecideTally {
  total: number;
  answered: number;
}

/** A save on its way, by `<message id>/<key>` (the thread's `pending`): its answer counts as the card shows it. */
export type PendingAnswers = ReadonlyMap<string, QuestionAnswer | null>;

const isAction = (q: InboxQuestion) => readInboxQuestionKind(q.kind) === 'action';

/** A message's questions and action items (the window keeps action items in `actions`, the server in `questions`). */
const decisionsOf = (m: InboxMessageWire) => [...(m.questions ?? []), ...(m.actions ?? [])];

export function decideTally(message: InboxMessageWire, pending: PendingAnswers = new Map()): DecideTally {
  let total = 0;
  let answered = 0;
  for (const q of decisionsOf(message)) {
    if (isAction(q)) {
      if (q.state === 'open' && inboxQuestionWaitsOnPerson(q)) total += 1;
      else if (inboxActionInDraft(q)) {
        total += 1;
        answered += 1;
      }
      continue;
    }
    if (!inboxQuestionWaitsOnPerson(q)) continue;
    total += 1;
    const id = `${message.id}/${q.key}`;
    const answer = pending.has(id) ? pending.get(id) : q.answer;
    if (answer && !isQuestionAnswerEmpty(answer)) answered += 1;
  }
  return { total, answered };
}

/** The messages that hold a decision now, in queue order: Stopped, then Holds up, then the thread's order. */
export function decideQueue(messages: readonly InboxMessageWire[], live: (m: InboxMessageWire) => boolean, pending?: PendingAnswers): string[] {
  const held = messages
    .map((m, at) => ({ m, at }))
    .filter(({ m }) => m.author.kind === 'agent' && live(m) && decideTally(m, pending).total > 0)
    .map(({ m, at }) => ({ id: m.id, at, urgency: Math.min(2, ...decisionsOf(m).filter((q) => inboxQuestionWaitsOnPerson(q) || inboxActionInDraft(q)).map((q) => inboxUrgencyOf(q))) }));
  return held.sort((a, b) => a.urgency - b.urgency || a.at - b.at).map((x) => x.id);
}

/**
 * One thread's sitting. `current`: the message on screen, null on the Send step. `later`: messages put off.
 * `fromSend`: a row on the Send step opened this message ("Back to Send").
 */
export interface Sitting {
  order: readonly string[];
  later: readonly string[];
  current: string | null;
  fromSend: boolean;
}

export function startSitting(queue: readonly string[]): Sitting {
  return { order: [...queue], later: [], current: queue[0] ?? null, fromSend: false };
}

/**
 * The sitting against the thread as it is now: a message that no longer holds a decision (sent, replaced, archived)
 * leaves the order, and one that arrived since joins it at the end, before Send. The message on screen stays on
 * screen; when it left, the next one in the order takes its place.
 */
export function syncSitting(s: Sitting, queue: readonly string[]): Sitting {
  const now = new Set(queue);
  const kept = s.order.filter((id) => now.has(id));
  const order = [...kept, ...queue.filter((id) => !kept.includes(id))];
  let current = s.current;
  if (current !== null && !now.has(current)) {
    const after = s.order.slice(s.order.indexOf(current) + 1).find((id) => now.has(id));
    current = after ?? null;
  }
  if (order.length === s.order.length && order.every((id, i) => id === s.order[i]) && current === s.current) return s;
  return { ...s, order, current, later: s.later.filter((id) => now.has(id)) };
}

/** Where a step is: its index in the order, the Send step being `order.length`. */
export const stepIndex = (s: Sitting) => (s.current === null ? s.order.length : s.order.indexOf(s.current));

export function goToStep(s: Sitting, index: number, fromSend = false): Sitting {
  const at = Math.max(0, Math.min(index, s.order.length));
  return { ...s, current: s.order[at] ?? null, fromSend };
}

export const next = (s: Sitting) => goToStep(s, stepIndex(s) + 1);
export const back = (s: Sitting) => goToStep(s, stepIndex(s) - 1);

/** Later: the message on screen moves to the end of the order (still before Send); the next one shows. */
export function putOff(s: Sitting): Sitting {
  if (s.current === null) return s;
  const at = stepIndex(s);
  const order = [...s.order.filter((id) => id !== s.current), s.current];
  return { ...s, order, later: s.later.includes(s.current) ? s.later : [...s.later, s.current], current: order[at] ?? null, fromSend: false };
}

/** Later is offered on every message but the last before Send, and never while changing an answer from Send. */
export const laterOffered = (s: Sitting) => s.current !== null && !s.fromSend && stepIndex(s) < s.order.length - 1;

/** The way in shows from two decisions (in the thread) up. */
export const DECIDE_ENTRY_MIN = 2;

/**
 * The way in's words, the first row of the thread's open questions: "Decide these 5" when the queue holds exactly
 * the questions the list shows, "Decide 5 one at a time" when action items wait too; once the person left before
 * Send, "Resume · 2 of 4 messages left" (`left` of `messages` not fully answered).
 */
export function decideEntryLabel(count: number, listed: number, resume: { left: number; messages: number } | null = null): string {
  if (resume) return `Resume · ${formatCount(resume.left)} of ${formatCount(resume.messages)} ${resume.messages === 1 ? 'message' : 'messages'} left`;
  return count === listed ? `Decide these ${formatCount(count)}` : `Decide ${formatCount(count)} one at a time`;
}
