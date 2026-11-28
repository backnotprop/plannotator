/**
 * The answer a person's tap or typed words make for an agent's question, and
 * the body that saves it (`POST /api/inbox/messages/:id/picks`). Pure, with no
 * window code, so every client that answers a question builds the same answer:
 * the window's decision mode (packages/inbox/decisions/model.ts), its client
 * (packages/inbox/api.ts) and the phone's contract vectors
 * (apps/mobile/contract, scripts/mobile/vectors.ts).
 */
import { readInboxQuestionKind, type InboxQuestion } from './inbox-types';
import { capQuestionPrompt, type QuestionAnswer } from './question-block';

/** The answer kind a question takes (an action item takes none: it is marked, not answered). */
function answerKind(question: InboxQuestion): QuestionAnswer['kind'] {
  const kind = readInboxQuestionKind(question.kind);
  return kind === 'multi' || kind === 'text' ? kind : 'single';
}

/** An answer to build on: the saved one, else empty. */
export function baseAnswer(question: InboxQuestion): QuestionAnswer {
  return question.answer ?? { v: 1, key: question.key, kind: answerKind(question), prompt: capQuestionPrompt(question.prompt), selected: [] };
}

export function choiceAnswer(question: InboxQuestion, selected: readonly string[], note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { other: _o, text: _t, skipped: _s, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [...selected], ...(note.trim() ? { note: note.trim() } : {}) };
}

export function otherAnswer(question: InboxQuestion, other: string, note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { text: _t, skipped: _s, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [], other: other.trim(), ...(note.trim() ? { note: note.trim() } : {}) };
}

export function textAnswer(question: InboxQuestion, text: string, note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { other: _o, skipped: _s, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [], text: text.trim(), ...(note.trim() ? { note: note.trim() } : {}) };
}

export function skipAnswer(question: InboxQuestion, note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { other: _o, text: _t, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [], skipped: true, ...(note.trim() ? { note: note.trim() } : {}) };
}

/** What saving one answer posts (null takes the answer back). `unsentOnly`: refused when a reply already sent the question. */
export function inboxPickBody(
  key: string,
  revision: number,
  answer: QuestionAnswer | null,
  options: { unsentOnly?: boolean; confirmFull?: boolean } = {},
): { questions: { key: string; revision: number; answer: QuestionAnswer | null }[]; unsent_only?: true; confirm_full?: true } {
  return {
    questions: [{ key, revision, answer }],
    ...(options.unsentOnly ? { unsent_only: true } : {}),
    ...(options.confirmFull ? { confirm_full: true } : {}),
  };
}
