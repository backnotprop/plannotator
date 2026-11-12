import {
  indexQuestionBlocks,
  QUESTION_ANSWER_ANNOTATION_PREFIX,
  type QuestionSourceBlock,
} from '@plannotator/shared/question-block';

interface AnnotationLike {
  questionAnswer?: unknown;
}

/** An answer to a `:::question` block: drawn by the question card from the
 *  annotation, never a text highlight (the `ann-checkbox-*` rule). */
export const isQuestionAnswerRow = (annotation: { id: string; questionAnswer?: unknown }): boolean =>
  annotation.questionAnswer != null || annotation.id.startsWith(QUESTION_ANSWER_ANNOTATION_PREFIX);

export const questionAnswerRemapper = (blocks: ReadonlyArray<QuestionSourceBlock>) => {
  const blockByKey = new Map(indexQuestionBlocks(blocks).map((q) => [q.question.key, q.blockId]));
  return <T extends { id: string; blockId: string; questionAnswer?: unknown }>(annotation: T): T => {
    if (!isQuestionAnswerRow(annotation)) return annotation;
    const key = (annotation.questionAnswer as { key?: unknown } | undefined)?.key;
    const blockId = typeof key === 'string' ? blockByKey.get(key) ?? '' : '';
    return blockId === annotation.blockId ? annotation : { ...annotation, blockId };
  };
};

export const countQuestionAnswers = (lists: Iterable<ReadonlyArray<AnnotationLike>>): number => {
  let count = 0;
  for (const list of lists) for (const a of list) if (a.questionAnswer != null) count++;
  return count;
};

export const isAnswersOnlyFeedback = (input: {
  answerCount: number;
  feedbackCount: number;
  hasDirectEdits: boolean;
  hasSavedFileChanges: boolean;
}): boolean =>
  input.answerCount > 0
  && input.feedbackCount === input.answerCount
  && !input.hasDirectEdits
  && !input.hasSavedFileChanges;

export const SEND_ANSWERS_LABEL = 'Send answers';

export const planDenyFeedbackFields = (
  payload: string,
  answersOnly: boolean,
): { feedback: string; answersOnly?: true } =>
  answersOnly ? { feedback: payload, answersOnly: true } : { feedback: payload };

/**
 * What a decision that drops feedback would lose, for the "Feedback won't be sent" and close
 * warnings:
 */
export const describeFeedbackLoss = (annotationCount: number, hasDirectEdits: boolean, answerCount = 0): string => {
  const answers = Math.min(Math.max(answerCount, 0), annotationCount);
  const others = annotationCount - answers;
  const parts = [
    answers > 0 ? `${answers} answer${answers !== 1 ? 's' : ''}` : '',
    others > 0 ? `${others} annotation${others !== 1 ? 's' : ''}` : '',
    hasDirectEdits ? 'direct edits' : '',
  ].filter(Boolean);
  if (parts.length === 0) return 'feedback';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
};
