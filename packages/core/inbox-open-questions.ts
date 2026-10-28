/**
 * Open questions inside one thread (approval "inbox-thread-open-questions",
 * option A, 2026-10-22): the "N open questions" button in the thread's foot
 * and the short list it opens. Pure: which questions are listed, how the
 * list names them, and when the button is shown at all.
 *
 * Listed: every question of a live agent message (not one an archive closed)
 * that waits on the person: open, or picked and not sent. Replaced questions
 * (`superseded`) are left out and counted apart; action items are not
 * questions and are left out. Answering stays on the real card: the list only
 * takes the person there.
 */

import type { InboxMessageWire, InboxQuestion } from './inbox-types';
import { readInboxQuestionKind } from './inbox-types';
import { inboxQuestionWaitsOnPerson } from './inbox-questions';
import { isQuestionAnswerEmpty, type QuestionAnswer } from './question-block';
import { formatCount } from './inbox-format';

/** One row of the list. */
export interface OpenQuestion {
  /** `<message id>/<key>`. */
  id: string;
  messageId: string;
  key: string;
  prompt: string;
  /** The message's time (ISO), which the row names. */
  at: string;
  /** Picked and not sent: the row reads "Draft · <pick>". */
  picked: boolean;
  question: InboxQuestion;
}

/** A question the person can still answer: not an action item, not a kind this window does not know. */
const isQuestion = (q: InboxQuestion) => {
  const kind = readInboxQuestionKind(q.kind);
  return kind !== 'unknown' && kind !== 'action';
};

/** Open, or picked and not sent: core's one "waits on the person" rule (decision mode and the list read it too). */
const waits = (q: InboxQuestion) => inboxQuestionWaitsOnPerson(q);

/**
 * The thread's open questions, in thread order, and how many replaced ones
 * were left out. `live` says which messages still take answers.
 */
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

/**
 * Whether the button is shown: whenever a question waits (owner, 2026-10-23:
 * the list now also holds Re-ask, so it must never be out of reach), or Re-ask
 * is offered with no question listed (only action items wait).
 */
export function openQuestionsShown(questions: readonly OpenQuestion[], reaskShown = false): boolean {
  return questions.length > 0 || reaskShown;
}

/** "5 open questions" / "1 open question"; `noun` "action item" when only action items wait. */
export function openQuestionsLabel(n: number, noun: OpenQuestionsNoun = 'question'): string {
  return `${formatCount(n)} open ${noun}${n === 1 ? '' : 's'}`;
}

/** What the button counts: questions, or action items when no question waits. */
export type OpenQuestionsNoun = 'question' | 'action item';

/** The list's accessible name: "5 open questions in this thread" (not drawn). */
export function openQuestionsHeading(n: number, noun: OpenQuestionsNoun = 'question'): string {
  return `${openQuestionsLabel(n, noun)} in this thread`;
}

/**
 * The Re-ask item at the list's foot (owner, 2026-10-23): "Re-ask in a new
 * message" when it asks for one thing again, else "Re-ask in one new message".
 */
export function reaskItemLabel(asked: number): string {
  return asked === 1 ? 'Re-ask in a new message' : 'Re-ask in one new message';
}

/** Where a question's card sits, as a row says it. */
export type OpenQuestionPlace = 'folded' | 'above' | 'below';

export function openQuestionPlaceWords(place: OpenQuestionPlace): string {
  return place === 'folded' ? 'in a folded message' : place;
}

/**
 * Above or below, from the card's middle against the middle of the thread's
 * view: a card half in view still reads where the most of it is, and the
 * list never needs a fourth word.
 */
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

/**
 * What the select mode's button does with the ticked rows (approval
 * "oq-skip-select", variant A): a ticked question not skipped yet is skipped,
 * a ticked skipped one is unskipped. Only questions that take a Skip count.
 */
export function skipSelection(questions: readonly OpenQuestion[], ticked: ReadonlySet<string>): { skip: OpenQuestion[]; unskip: OpenQuestion[] } {
  const skip: OpenQuestion[] = [];
  const unskip: OpenQuestion[] = [];
  for (const q of questions) {
    if (!ticked.has(q.id) || !openQuestionSkippable(q)) continue;
    (openQuestionSkipped(q) ? unskip : skip).push(q);
  }
  return { skip, unskip };
}

/**
 * What "Skip all N" covers: the open questions with nothing picked. A draft
 * pick, and a question already skipped, stay as they are.
 */
export function skipAllCandidates(questions: readonly OpenQuestion[]): OpenQuestion[] {
  return questions.filter((q) => !q.picked && !openQuestionSkipped(q) && openQuestionSkippable(q));
}

/**
 * Whether a row can be skipped: exactly when its card offers Skip (an open or picked
 * question; a sent, closed or replaced one, and an action item, take none).
 * The list holds only such questions, so this is a guard, not a filter.
 */
export function openQuestionSkippable(q: OpenQuestion): boolean {
  return isQuestion(q.question) && waits(q.question);
}

/**
 * What a Skip from the list saves: the answer the card's own Skip makes from
 * the same starting answer (ui's QuestionBlock `toggleSkip`, then its
 * `commit`). Skipped already: the skip comes off (Unskip), the note stays.
 * Otherwise the choices, Other and the text go and `skipped` is set, the note
 * staying. An answer left with nothing in it is null (the pick is cleared).
 * `base` is the card's: its saved or pending answer, else the question's
 * empty answer.
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
