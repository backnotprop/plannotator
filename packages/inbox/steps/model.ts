/**
 * Thread steps in the window (approval "inbox-thread-steps", 2026-11-03, A1
 * "Linear"): what the foot's button, its popover or sheet, and the Board's
 * opened card draw from a thread's lists. Pure: no DOM, no fetch.
 *
 * One list per agent session (the server's read, latest first). A cleared
 * list (no steps) shows nothing. Done of total counts every step but dropped
 * ones (`inboxStepsProgress`). A row's right side: a done step's time, a
 * doing, todo or dropped step's note, and for a waiting step "Waiting on
 * you ›", which goes to that session's open question (or action item).
 */

import { inboxStepsProgress, type InboxStep, type InboxStepStatus, type InboxStepsPresence, type InboxStepsWire } from '@plannotator/core/inbox-types';
import type { OpenActionItem, OpenQuestion } from '@plannotator/core/inbox-open-questions';
import { agentName, shortTime, whenTime } from '../format';

/** The lists the window shows: those with steps (a cleared list is gone), in the server's order. */
export function shownStepLists(lists: readonly InboxStepsWire[]): InboxStepsWire[] {
  return lists.filter((list) => list.steps.length > 0);
}

/**
 * A Board card's lists (approval part 4: "the thread is one Board card; its steps are inside it"): the lists of
 * every thread the card links (the cards read's `steps`), the latest written first. The lane card's mark is the
 * first one's.
 */
export function cardStepLists(threads: readonly string[], steps: Readonly<Record<string, readonly InboxStepsWire[]>> | undefined): InboxStepsWire[] {
  if (!steps) return [];
  const lists = threads.flatMap((id) => shownStepLists(steps[id] ?? []));
  return lists.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
}

/**
 * The opened Board card's lists, said the way its head says the session: once the head reads "ended" (the Board's
 * rule, not live), the card agent's own lists read ended too (the grey dashed mark, "· as of 2:40 PM"), so one card
 * never shows an ended agent beside a list still turning. Another session's list, or any other head, as served.
 */
export function stepsAsCardHeadSays<T extends Pick<InboxStepsWire, 'presence' | 'agent'>>(lists: readonly T[], session: string | null, state: string | null): T[] {
  if (state !== 'ended' || !session) return [...lists];
  return lists.map((list) => (list.agent.session === session && list.presence !== 'ended' ? { ...list, presence: 'ended' } : list));
}

/** The Board card the checklist head's Board icon opens: the first card (the Board's order) that links the thread, not a cancelled one. */
export function threadBoardCard<T extends { threads: readonly string[]; column: string }>(cards: readonly T[], threadId: string): T | null {
  return cards.find((card) => card.column !== 'dropped' && card.threads.includes(threadId)) ?? null;
}

/** The lane card's mark, read aloud and on hover: "3 of 6 steps done" (no count on the card itself). */
export function stepsDoneWords(list: Pick<InboxStepsWire, 'steps'>): string {
  const { done, total } = stepsCount(list);
  return `${done} of ${total} steps done`;
}

/**
 * Each list's head when there is more than one: its agent's name, and where two sessions of one agent keep lists in
 * the thread, a number for each ("Claude Code · 1", "Claude Code · 2") in the order the sessions started their lists
 * (their `stp_` ids), so a list keeps its number as the other one ticks.
 */
export function stepsListLabels(lists: readonly Pick<InboxStepsWire, 'id' | 'agent'>[]): string[] {
  const names = lists.map((list) => agentName(list.agent));
  return lists.map((list, index) => {
    const same = lists.filter((_, j) => names[j] === names[index]);
    if (same.length < 2) return names[index]!;
    const order = same.map((other) => other.id).sort();
    return `${names[index]} · ${order.indexOf(list.id) + 1}`;
  });
}

/** How a step reads to a screen reader after its text. */
export const STEP_STATUS_WORDS: Record<InboxStepStatus, string> = {
  todo: 'not started',
  doing: 'in progress',
  done: 'done',
  waiting: 'waiting on you',
  dropped: 'dropped',
};

/** A row's right side: a done step's time, a note, "Waiting on you ›", or nothing. */
export type StepMeta = { kind: 'time'; text: string; title: string } | { kind: 'note'; text: string } | { kind: 'waiting' } | null;

export function stepMeta(step: InboxStep, now: Date = new Date()): StepMeta {
  if (step.status === 'waiting') return { kind: 'waiting' };
  if (step.status === 'done') {
    const text = shortTime(step.at, now);
    return text ? { kind: 'time', text, title: whenTime(step.at, now) } : null;
  }
  return step.note ? { kind: 'note', text: step.note } : null;
}

/** The head's quiet "as of 2:40 PM", once the session has ended: the list's last word. Null while it is there. */
export function stepsAsOf(list: Pick<InboxStepsWire, 'presence' | 'updated_at'>, now: Date = new Date()): string | null {
  return list.presence === 'ended' ? whenTime(list.updated_at, now) || null : null;
}

/** "3/6" and its parts. */
export function stepsCount(list: Pick<InboxStepsWire, 'steps'>): { done: number; total: number; text: string } {
  const { done, total } = inboxStepsProgress(list.steps);
  return { done, total, text: `${done}/${total}` };
}

/** The button's and the panel's name: "Claude Code's checklist: 3 of 6 steps done" (owner, 2026-11-03: on screen it is the checklist; each line a step). */
export function stepsName(agent: string, list: Pick<InboxStepsWire, 'steps'>): string {
  const { done, total } = stepsCount(list);
  return `${agent}'s checklist: ${done} of ${total} steps done`;
}

/** Where "Waiting on you ›" goes: an open question, or else an open action item, of that session first. */
export type StepsWaitTarget = { kind: 'question' | 'action'; messageId: string; key: string };

export function stepsWaitTarget(
  session: string | null,
  questions: readonly OpenQuestion[],
  actions: readonly OpenActionItem[],
  sessionOf: (messageId: string) => string | null,
): StepsWaitTarget | null {
  const mine = <T extends { messageId: string }>(items: readonly T[]) => (session ? items.find((item) => sessionOf(item.messageId) === session) : undefined);
  const question = mine(questions);
  if (question) return { kind: 'question', messageId: question.messageId, key: question.key };
  const action = mine(actions);
  if (action) return { kind: 'action', messageId: action.messageId, key: action.key };
  // The session's own asks are answered; another open ask in the thread is still the person's move.
  if (questions[0]) return { kind: 'question', messageId: questions[0].messageId, key: questions[0].key };
  if (actions[0]) return { kind: 'action', messageId: actions[0].messageId, key: actions[0].key };
  return null;
}

/** The class the presence gives the panel and the button: the in-progress mark turns only while `working`. */
export function presenceClass(presence: InboxStepsPresence): string {
  return `ib-st-${presence}`;
}

/**
 * The plan's mark (Linear's project progress): a ring, and the done share as a wedge inside it. The same on the
 * button, the head, the Board's lane card and its opened card. `path` is null for none done; `full` for all.
 */
export function pieGeometry(done: number, total: number, size: number): { c: number; r: number; ri: number; path: string | null; full: boolean } {
  const c = size / 2;
  const r = c - 0.9;
  const ri = r - 2;
  const share = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  if (share >= 1) return { c, r, ri, path: null, full: true };
  if (share <= 0) return { c, r, ri, path: null, full: false };
  const angle = share * 2 * Math.PI;
  const x = c + ri * Math.sin(angle);
  const y = c - ri * Math.cos(angle);
  return { c, r, ri, path: `M${c} ${c}V${c - ri}A${ri} ${ri} 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`, full: false };
}
