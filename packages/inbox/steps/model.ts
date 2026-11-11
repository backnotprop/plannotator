/**
 * Thread steps in the window (approval "inbox-thread-steps", 2026-11-03; the
 * marks are "inbox-checklist-spinners-2026-11-07", mock 1 "today's layout with
 * spinners", its 11:25Z addendum): what the foot's button and its popover or
 * sheet draw from a thread's lists. The checklist lives only in its thread
 * (owner, 2026-11-09): no list row or Board card shows it. Pure: no DOM, no
 * fetch.
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

/** The Board card the checklist head's Board icon opens: the first card (the Board's order) that links the thread, not a cancelled one. */
export function threadBoardCard<T extends { threads: readonly string[]; column: string }>(cards: readonly T[], threadId: string): T | null {
  return cards.find((card) => card.column !== 'dropped' && card.threads.includes(threadId)) ?? null;
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

/** The class the presence gives a list and the foot's button: the spinner turns only while `working`. */
export function presenceClass(presence: InboxStepsPresence): string {
  return `ib-st-${presence}`;
}

/**
 * The plan's mark (Linear's project progress): a ring, and the done share as a wedge inside it. On the foot's button
 * when no step is worked on or waits (fresh, all done), and on each list's head. `path` is null for none done; `full`
 * for all.
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

/**
 * The person answered in the thread since a time (`inboxPersonAnsweredSince` over the thread's messages: a reply of
 * theirs or a 👍 Looks good). Where the window has no thread (the intro's picture), nobody answered.
 */
export type StepsAnsweredSince = (since: string) => boolean;
const nobodyAnswered: StepsAnsweredSince = () => false;

/**
 * A list still waits on the person, by the server's rule for the row's `steps_waiting` (`inboxStepsWaitOnPerson`): a
 * step is `waiting`, its session has not ended (an ended session never updates its list), and the person has not
 * answered since the list was last written. The foot's button, its name and its list agree by it.
 */
export function stepsListWaits(list: Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>, answeredSince: StepsAnsweredSince = nobodyAnswered): boolean {
  return list.presence !== 'ended' && list.steps.some((step) => step.status === 'waiting') && !answeredSince(list.updated_at);
}

/**
 * The foot button's mark (approval "inbox-checklist-spinners-2026-11-07", mock 1): the current step's mark, the amber
 * pause while the list waits on the person (`stepsListWaits`), else the spinner while a step is worked on; null
 * otherwise (fresh, all done), when the button keeps the pie.
 */
export function stepsButtonMark(list: Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>, answeredSince: StepsAnsweredSince = nobodyAnswered): 'waiting' | 'doing' | null {
  if (stepsListWaits(list, answeredSince)) return 'waiting';
  if (list.steps.some((step) => step.status === 'doing')) return 'doing';
  return null;
}

/** The list the foot's button shows: one that waits on the person first (that is what they need to see), else the newest. */
export function stepsButtonList<T extends Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>>(lists: readonly T[], answeredSince: StepsAnsweredSince = nobodyAnswered): T | null {
  return lists.find((list) => stepsListWaits(list, answeredSince)) ?? lists[0] ?? null;
}

/**
 * What the foot's button shows, as a key: the list it shows, its count, its mark, "as of" and "+1". The thread's foot
 * row fits itself again whenever it changes (a session ending mid-read adds "as of"; another list can win).
 */
export function stepsButtonSig(lists: readonly InboxStepsWire[], answeredSince: StepsAnsweredSince = nobodyAnswered): string {
  const shown = stepsButtonList(lists, answeredSince);
  if (!shown) return '';
  return [shown.id, stepsCount(shown).text, stepsButtonMark(shown, answeredSince) ?? 'pie', shown.presence === 'ended' ? 'asof' : '', lists.length].join(':');
}

/** The waiting step the button's name adds ("; waiting on you: Pick the window"), while its list waits; else "". */
export function stepsWaitingNameTail(list: Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>, answeredSince: StepsAnsweredSince = nobodyAnswered): string {
  const step = stepsListWaits(list, answeredSince) ? list.steps.find((one) => one.status === 'waiting') : undefined;
  return step ? `; waiting on you: ${step.step}` : '';
}
