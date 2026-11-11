import { inboxStepsProgress, type InboxStep, type InboxStepStatus, type InboxStepsPresence, type InboxStepsWire } from '@plannotator/core/inbox-types';
import type { OpenActionItem, OpenQuestion } from '@plannotator/core/inbox-open-questions';
import { agentName, shortTime, whenTime } from '../format';

export function shownStepLists(lists: readonly InboxStepsWire[]): InboxStepsWire[] {
  return lists.filter((list) => list.steps.length > 0);
}

export function threadBoardCard<T extends { threads: readonly string[]; column: string }>(cards: readonly T[], threadId: string): T | null {
  return cards.find((card) => card.column !== 'dropped' && card.threads.includes(threadId)) ?? null;
}

export function stepsListLabels(lists: readonly Pick<InboxStepsWire, 'id' | 'agent'>[]): string[] {
  const names = lists.map((list) => agentName(list.agent));
  return lists.map((list, index) => {
    const same = lists.filter((_, j) => names[j] === names[index]);
    if (same.length < 2) return names[index]!;
    const order = same.map((other) => other.id).sort();
    return `${names[index]} · ${order.indexOf(list.id) + 1}`;
  });
}

export const STEP_STATUS_WORDS: Record<InboxStepStatus, string> = {
  todo: 'not started',
  doing: 'in progress',
  done: 'done',
  waiting: 'waiting on you',
  dropped: 'dropped',
};

export type StepMeta = { kind: 'time'; text: string; title: string } | { kind: 'note'; text: string } | { kind: 'waiting' } | null;

export function stepMeta(step: InboxStep, now: Date = new Date()): StepMeta {
  if (step.status === 'waiting') return { kind: 'waiting' };
  if (step.status === 'done') {
    const text = shortTime(step.at, now);
    return text ? { kind: 'time', text, title: whenTime(step.at, now) } : null;
  }
  return step.note ? { kind: 'note', text: step.note } : null;
}

export function stepsAsOf(list: Pick<InboxStepsWire, 'presence' | 'updated_at'>, now: Date = new Date()): string | null {
  return list.presence === 'ended' ? whenTime(list.updated_at, now) || null : null;
}

export function stepsCount(list: Pick<InboxStepsWire, 'steps'>): { done: number; total: number; text: string } {
  const { done, total } = inboxStepsProgress(list.steps);
  return { done, total, text: `${done}/${total}` };
}

export function stepsName(agent: string, list: Pick<InboxStepsWire, 'steps'>): string {
  const { done, total } = stepsCount(list);
  return `${agent}'s checklist: ${done} of ${total} steps done`;
}

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
  if (questions[0]) return { kind: 'question', messageId: questions[0].messageId, key: questions[0].key };
  if (actions[0]) return { kind: 'action', messageId: actions[0].messageId, key: actions[0].key };
  return null;
}

export function presenceClass(presence: InboxStepsPresence): string {
  return `ib-st-${presence}`;
}

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

export type StepsAnsweredSince = (since: string) => boolean;
const nobodyAnswered: StepsAnsweredSince = () => false;

export function stepsListWaits(list: Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>, answeredSince: StepsAnsweredSince = nobodyAnswered): boolean {
  return list.presence !== 'ended' && list.steps.some((step) => step.status === 'waiting') && !answeredSince(list.updated_at);
}

export function stepsButtonMark(list: Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>, answeredSince: StepsAnsweredSince = nobodyAnswered): 'waiting' | 'doing' | null {
  if (stepsListWaits(list, answeredSince)) return 'waiting';
  if (list.steps.some((step) => step.status === 'doing')) return 'doing';
  return null;
}

export function stepsButtonList<T extends Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>>(lists: readonly T[], answeredSince: StepsAnsweredSince = nobodyAnswered): T | null {
  return lists.find((list) => stepsListWaits(list, answeredSince)) ?? lists[0] ?? null;
}

export function stepsButtonSig(lists: readonly InboxStepsWire[], answeredSince: StepsAnsweredSince = nobodyAnswered): string {
  const shown = stepsButtonList(lists, answeredSince);
  if (!shown) return '';
  return [shown.id, stepsCount(shown).text, stepsButtonMark(shown, answeredSince) ?? 'pie', shown.presence === 'ended' ? 'asof' : '', lists.length].join(':');
}

export function stepsWaitingNameTail(list: Pick<InboxStepsWire, 'steps' | 'presence' | 'updated_at'>, answeredSince: StepsAnsweredSince = nobodyAnswered): string {
  const step = stepsListWaits(list, answeredSince) ? list.steps.find((one) => one.status === 'waiting') : undefined;
  return step ? `; waiting on you: ${step.step}` : '';
}
