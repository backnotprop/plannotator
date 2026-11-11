import type { InboxMessageWire, InboxQuestion } from './inbox-types';
import { readInboxQuestionKind } from './inbox-types';
import { inboxQuestionWaitsOnPerson } from './inbox-questions';
import { isQuestionAnswerEmpty, type QuestionAnswer } from './question-block';
import { formatCount } from './inbox-format';

/** One row of the list. */
export interface OpenQuestion {
  id: string;
  messageId: string;
  key: string;
  prompt: string;
  at: string;
  picked: boolean;
  question: InboxQuestion;
}

const isQuestion = (q: InboxQuestion) => {
  const kind = readInboxQuestionKind(q.kind);
  return kind !== 'unknown' && kind !== 'action';
};

const waits = (q: InboxQuestion) => inboxQuestionWaitsOnPerson(q);

/** The thread's open questions, in thread order, and how many replaced ones were left out. */
export function threadOpenQuestions(
  messages: readonly InboxMessageWire[],
  live: (message: InboxMessageWire) => boolean = () => true,
): { questions: OpenQuestion[]; replaced: number } {
  const questions: OpenQuestion[] = [];
  let replaced = 0;
  for (const m of messages) {
    if (m.author.kind !== 'agent' || !live(m)) continue;
    for (const q of m.questions ?? []) {
      if (!isQuestion(q)) continue;
      if (q.state === 'superseded') {
        replaced += 1;
        continue;
      }
      if (!waits(q)) continue;
      questions.push({ id: `${m.id}/${q.key}`, messageId: m.id, key: q.key, prompt: q.prompt, at: m.created_at, picked: q.state === 'picked' && q.answer != null, question: q });
    }
  }
  return { questions, replaced };
}

/** One open action item in the list: a row that takes the person to its checklist row. */
export interface OpenActionItem {
  id: string;
  messageId: string;
  key: string;
  prompt: string;
  at: string;
  action: InboxQuestion;
}

export function threadOpenActions(
  messages: readonly InboxMessageWire[],
  live: (message: InboxMessageWire) => boolean = () => true,
): OpenActionItem[] {
  const items: OpenActionItem[] = [];
  for (const m of messages) {
    if (m.author.kind !== 'agent' || !live(m)) continue;
    for (const a of [...(m.questions ?? []), ...(m.actions ?? [])]) {
      if (readInboxQuestionKind(a.kind) !== 'action' || a.state !== 'open' || !waits(a)) continue;
      items.push({ id: `${m.id}/${a.key}`, messageId: m.id, key: a.key, prompt: a.prompt, at: m.created_at, action: a });
    }
  }
  return items;
}

export function openQuestionsShown(questions: readonly OpenQuestion[], reaskShown = false, actions = 0): boolean {
  return questions.length > 0 || actions > 0 || reaskShown;
}

export function openItemsLabel(questions: number, actions: number): string {
  if (actions === 0) return openQuestionsLabel(questions);
  if (questions === 0) return openQuestionsLabel(actions, 'action item');
  const each = (n: number, noun: string) => `${formatCount(n)} ${noun}${n === 1 ? '' : 's'}`;
  return `${each(questions, 'question')}, ${each(actions, 'action item')}`;
}

/** The list's accessible name: "2 questions, 1 action item in this thread" (not drawn). */
export function openItemsHeading(questions: number, actions: number): string {
  return `${openItemsLabel(questions, actions)} in this thread`;
}

/** The state an action item's row shows: Stopped, else Holds up, else nothing. */
export function openActionState(a: OpenActionItem): OpenQuestionState {
  if (a.action.stopped) return { kind: 'stopped' };
  if (a.action.holds_up.length > 0) return { kind: 'holds', count: a.action.holds_up.length };
  return null;
}

export function openQuestionsLabel(n: number, noun: OpenQuestionsNoun = 'question'): string {
  if (noun === 'permission') return `${formatCount(n)} permission${n === 1 ? '' : 's'} waiting`;
  return `${formatCount(n)} open ${noun}${n === 1 ? '' : 's'}`;
}

/** What the button counts: questions, action items when no question waits, or permission prompts when only those wait. */
export type OpenQuestionsNoun = 'question' | 'action item' | 'permission';

/** The list's accessible name: "5 open questions in this thread" (not drawn). */
export function openQuestionsHeading(n: number, noun: OpenQuestionsNoun = 'question'): string {
  return `${openQuestionsLabel(n, noun)} in this thread`;
}

export function reaskItemLabel(asked: number): string {
  return asked === 1 ? 'Re-ask in a new message' : 'Re-ask in one new message';
}

/** Where a question's card sits, as a row says it. */
export type OpenQuestionPlace = 'folded' | 'above' | 'below';

export function openQuestionPlaceWords(place: OpenQuestionPlace): string {
  return place === 'folded' ? 'in a folded message' : place;
}

export function placeOf(card: { top: number; bottom: number } | null, view: { top: number; bottom: number }): 'above' | 'below' {
  if (!card) return 'below';
  return (card.top + card.bottom) / 2 < (view.top + view.bottom) / 2 ? 'above' : 'below';
}

/** The state a row shows: the draft pick first, else Stopped, else Holds up, else nothing. */
export type OpenQuestionState = { kind: 'draft' } | { kind: 'stopped' } | { kind: 'holds'; count: number } | null;

export function openQuestionState(q: OpenQuestion): OpenQuestionState {
  if (q.picked) return { kind: 'draft' };
  if (q.question.stopped) return { kind: 'stopped' };
  if (q.question.holds_up.length > 0) return { kind: 'holds', count: q.question.holds_up.length };
  return null;
}

/** The row's question is skipped in the person's draft: the row goes quiet, and the card's Skip reads "Unskip". */
export function openQuestionSkipped(q: OpenQuestion): boolean {
  return q.question.answer?.skipped === true;
}

export function skipSelection(questions: readonly OpenQuestion[], ticked: ReadonlySet<string>): { skip: OpenQuestion[]; unskip: OpenQuestion[] } {
  const skip: OpenQuestion[] = [];
  const unskip: OpenQuestion[] = [];
  for (const q of questions) {
    if (!ticked.has(q.id) || !openQuestionSkippable(q)) continue;
    (openQuestionSkipped(q) ? unskip : skip).push(q);
  }
  return { skip, unskip };
}

/** What "Skip all N" covers: the open questions with nothing picked. */
export function skipAllCandidates(questions: readonly OpenQuestion[]): OpenQuestion[] {
  return questions.filter((q) => !q.picked && !openQuestionSkipped(q) && openQuestionSkippable(q));
}

/**
 * Whether a row can be skipped: exactly when its card offers Skip (an open or picked question; a
 * sent, closed or replaced one, and an action item, take none).
 */
export function openQuestionSkippable(q: OpenQuestion): boolean {
  return isQuestion(q.question) && waits(q.question);
}

/**
 * What a Skip from the list saves: the answer the card's own Skip makes from the same starting
 * answer (ui's QuestionBlock `toggleSkip`, then its `commit`).
 */
export function skipToggledAnswer(base: QuestionAnswer): QuestionAnswer | null {
  let next: QuestionAnswer;
  if (base.skipped) {
    const { skipped: _skipped, ...rest } = base;
    next = rest;
  } else {
    const { other: _other, text: _text, ...rest } = base;
    next = { ...rest, selected: [], skipped: true };
  }
  return isQuestionAnswerEmpty(next) ? null : next;
}
