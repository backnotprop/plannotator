/**
 * Plan review with `:::question` answers.
 *
 * What regresses if this fails: the plan-review primary reads "Send answers"
 * while comments or edits are also going out (or stops reading it when only
 * answers are), the answers-only deny stops flagging
 * `answersOnly` (the server's plan.answered prompt) or starts framing the
 * export a second time, the "Feedback won't be sent" warning stops naming the
 * answers (or changes wording for documents without questions), or Edit Mode
 * leaves an answer pointing at a stale block id.
 */
import { describe, expect, test } from 'bun:test';
import { indexQuestionBlocks } from '@plannotator/shared/question-block';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { questionAnswerToAnnotation } from '@plannotator/ui/utils/questionAnswers';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import {
  countQuestionAnswers,
  describeFeedbackLoss,
  isAnswersOnlyFeedback,
  planDenyFeedbackFields,
  questionAnswerRemapper,
} from './questionDecision';

describe('isAnswersOnlyFeedback', () => {
  const base = { answerCount: 2, feedbackCount: 2, hasDirectEdits: false, hasSavedFileChanges: false };
  test('only answers', () => {
    expect(isAnswersOnlyFeedback(base)).toBe(true);
  });
  test('a comment, a direct edit or a saved file change makes it ordinary feedback', () => {
    expect(isAnswersOnlyFeedback({ ...base, feedbackCount: 3 })).toBe(false);
    expect(isAnswersOnlyFeedback({ ...base, hasDirectEdits: true })).toBe(false);
    expect(isAnswersOnlyFeedback({ ...base, hasSavedFileChanges: true })).toBe(false);
  });
  test('no answers is never answers-only', () => {
    expect(isAnswersOnlyFeedback({ ...base, answerCount: 0, feedbackCount: 0 })).toBe(false);
  });
});

describe('planDenyFeedbackFields', () => {
  const payload = '# Plan Feedback\n\n## Answers to your questions\n\n1 of 1 question answered.\n';
  test('answers only: the flag rides the body and the export goes out unframed', () => {
    // The server's plan.answered prompt carries the framing; a paragraph in
    // the body as well would say it twice.
    expect(planDenyFeedbackFields(payload, true)).toEqual({ feedback: payload, answersOnly: true });
  });
  test('ordinary feedback: no flag, the body is unchanged', () => {
    const body = planDenyFeedbackFields(payload, false);
    expect(body).toEqual({ feedback: payload });
    expect('answersOnly' in body).toBe(false);
  });
});

describe('describeFeedbackLoss', () => {
  test('without answers the wording is unchanged', () => {
    expect(describeFeedbackLoss(0, false)).toBe('feedback');
    expect(describeFeedbackLoss(1, false)).toBe('1 annotation');
    expect(describeFeedbackLoss(3, true)).toBe('3 annotations and direct edits');
    expect(describeFeedbackLoss(0, true)).toBe('direct edits');
  });
  test('answers are named on their own', () => {
    expect(describeFeedbackLoss(2, false, 2)).toBe('2 answers');
    expect(describeFeedbackLoss(3, false, 1)).toBe('1 answer and 2 annotations');
    expect(describeFeedbackLoss(3, true, 1)).toBe('1 answer, 2 annotations and direct edits');
  });
});

describe('questionAnswerRemapper (Edit Mode)', () => {
  const doc = (prompt: string) => `# Plan\n\nIntro.\n\n:::question\n${prompt}\n\n- [ ] A\n- [ ] B\n:::\n`;
  const blocks = parseMarkdownToBlocks(doc('Pick one?'));
  const [q] = indexQuestionBlocks(blocks);
  const answer = questionAnswerToAnnotation(q.blockId, {
    v: 1, key: q.question.key, kind: 'single', prompt: 'Pick one?', selected: ['A'],
  }, 1);
  const comment: Annotation = {
    id: 'c1', blockId: blocks[1].id, startOffset: 0, endOffset: 5, type: AnnotationType.COMMENT, text: 'x', originalText: 'Intro', createdA: 2,
  };

  test('an answer follows its question to the new block after an edit above it', () => {
    const edited = parseMarkdownToBlocks(`# Plan\n\nA new paragraph.\n\n${doc('Pick one?').slice('# Plan\n\n'.length)}`);
    const [moved] = indexQuestionBlocks(edited);
    expect(moved.blockId).not.toBe(q.blockId);
    const remapped = questionAnswerRemapper(edited)(answer);
    expect(remapped.blockId).toBe(moved.blockId);
    expect(remapped.questionAnswer).toEqual(answer.questionAnswer);
  });

  test('a reworded prompt orphans the answer (blockId empty), keeping the answer itself', () => {
    const remapped = questionAnswerRemapper(parseMarkdownToBlocks(doc('Pick exactly one?')))(answer);
    expect(remapped.blockId).toBe('');
    expect(remapped.questionAnswer).toEqual(answer.questionAnswer);
  });

  test('other annotations pass through untouched', () => {
    expect(questionAnswerRemapper(blocks)(comment)).toBe(comment);
    expect(countQuestionAnswers([[comment, answer]])).toBe(1);
  });
});
