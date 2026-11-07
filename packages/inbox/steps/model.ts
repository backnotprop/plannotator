/**
 * Thread steps in the window (approval "inbox-thread-steps", 2026-11-03; the
 * look is "inbox-checklist-spinners-2026-11-07", Take C with spinners): what
 * the line at the top of the thread, the list it opens, the list row, the
 * Board's lane card and its opened card draw from a thread's lists. Pure: no
 * DOM, no fetch.
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
  // A dropped step says so in words, beside its struck words (approval "inbox-checklist-spinners-2026-11-07").
  if (step.status === 'dropped') return { kind: 'note', text: step.note ? `Dropped: ${step.note}` : 'Dropped' };
  return step.note ? { kind: 'note', text: step.note } : null;
}

/** The head's quiet "as of 2:40 PM", once the session has ended: the list's last word. Null while it is there. */
export function stepsAsOf(list: Pick<InboxStepsWire, 'presence' | 'updated_at'>, now: Date = new Date()): string | null {
  return list.presence === 'ended' ? whenTime(list.updated_at, now) || null : null;
}

/** "3 of 6 done" and its parts. */
export function stepsCount(list: Pick<InboxStepsWire, 'steps'>): { done: number; total: number; text: string } {
  const { done, total } = inboxStepsProgress(list.steps);
  return { done, total, text: `${done} of ${total} done` };
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

/** The class the presence gives a list and the line: the spinner turns only while `working`. */
export function presenceClass(presence: InboxStepsPresence): string {
  return `ib-st-${presence}`;
}

/**
 * What the line at the top of the thread says for a list (approval "inbox-checklist-spinners-2026-11-07"):
 *  - a step waiting on the person: "Waiting on you: <step>" (the first words amber), with the amber pause;
 *  - else the step in progress: "<step>", with the spinner;
 *  - else every counted step done: "All steps done", with the check, and "6 of 6" (no "done" twice);
 *  - else the next step: "Next: <step>", with the empty ring.
 * `count` is the quieter count after it ("2 of 4 done").
 */
export type StepsLine = { kind: 'waiting' | 'doing' | 'next' | 'done'; step: string | null; mark: InboxStepStatus; count: string };

export function stepsLine(list: Pick<InboxStepsWire, 'steps'>): StepsLine {
  const { done, total } = inboxStepsProgress(list.steps);
  const count = `${done} of ${total} done`;
  const waiting = list.steps.find((step) => step.status === 'waiting');
  if (waiting) return { kind: 'waiting', step: waiting.step, mark: 'waiting', count };
  const doing = list.steps.find((step) => step.status === 'doing');
  if (doing) return { kind: 'doing', step: doing.step, mark: 'doing', count };
  const next = list.steps.find((step) => step.status === 'todo');
  if (!next) return { kind: 'done', step: null, mark: 'done', count: `${done} of ${total}` };
  return { kind: 'next', step: next.step, mark: 'todo', count };
}

/** The list the line names: one that waits on the person first (that is what they need to see), else the newest. */
export function stepsLineList<T extends Pick<InboxStepsWire, 'steps'>>(lists: readonly T[]): T | null {
  return lists.find((list) => list.steps.some((step) => step.status === 'waiting')) ?? lists[0] ?? null;
}

/** Some list waits on the person: the list row's and the lane card's still amber pause (nothing else shows there). */
export function stepsWaitOnPerson(lists: readonly Pick<InboxStepsWire, 'steps'>[]): boolean {
  return lists.some((list) => list.steps.some((step) => step.status === 'waiting'));
}

/** The lane card's amber pause, read aloud and on hover: "Checklist: 2 of 4 steps done; waiting on you: Pick the window". Null when nothing waits. */
export function stepsWaitWords(lists: readonly Pick<InboxStepsWire, 'steps'>[]): string | null {
  const list = lists.find((one) => one.steps.some((step) => step.status === 'waiting'));
  const step = list?.steps.find((one) => one.status === 'waiting');
  return list && step ? `Checklist: ${stepsDoneWords(list)}; waiting on you: ${step.step}` : null;
}

/** The line's name: whose checklist, how far, and the step it names ("…: 2 of 4 steps done; waiting on you: Pick the window"). */
export function stepsLineName(agent: string, list: Pick<InboxStepsWire, 'steps'>): string {
  const line = stepsLine(list);
  const base = stepsName(agent, list);
  if (line.kind === 'waiting') return `${base}; waiting on you: ${line.step}`;
  if (line.kind === 'doing') return `${base}; doing: ${line.step}`;
  if (line.kind === 'next') return `${base}; next: ${line.step}`;
  return base;
}

