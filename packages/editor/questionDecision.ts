/**
 * Plan review decisions and document-edit rules for `:::question` answers.
 * Pure, so the rules are testable without mounting the app.
 */
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

/**
 * After the document text changes (Edit Mode, a draft restore of edits),
 * re-point each answer at its question's new block by question KEY. The
 * prompt is the answer's quote, so the text-search remap other annotations
 * get would be wrong for it; a reworded prompt is a different question, and
 * its answer gets blockId '' (listed Unanchored, still exported). Returns
 * the same object when nothing changes. Non-answers pass through untouched.
 */
export const questionAnswerRemapper = (blocks: ReadonlyArray<QuestionSourceBlock>) => {
  const blockByKey = new Map(indexQuestionBlocks(blocks).map((q) => [q.question.key, q.blockId]));
  return <T extends { id: string; blockId: string; questionAnswer?: unknown }>(annotation: T): T => {
    if (!isQuestionAnswerRow(annotation)) return annotation;
    const key = (annotation.questionAnswer as { key?: unknown } | undefined)?.key;
    const blockId = typeof key === 'string' ? blockByKey.get(key) ?? '' : '';
    return blockId === annotation.blockId ? annotation : { ...annotation, blockId };
  };
};

/** How many of these annotations are question answers. */
export const countQuestionAnswers = (lists: Iterable<ReadonlyArray<AnnotationLike>>): number => {
  let count = 0;
  for (const list of lists) for (const a of list) if (a.questionAnswer != null) count++;
  return count;
};

/**
 * The only feedback is question answers: no comment, no attachment, no
 * direct edit and no saved file change. Plan review then labels its primary
 * "Send answers" and frames the deny for the agent as answers, not as
 * requested changes.
 */
export const isAnswersOnlyFeedback = (input: {
  answerCount: number;
  /** Every feedback item the decision control counts (answers included). */
  feedbackCount: number;
  hasDirectEdits: boolean;
  hasSavedFileChanges: boolean;
}): boolean =>
  input.answerCount > 0
  && input.feedbackCount === input.answerCount
  && !input.hasDirectEdits
  && !input.hasSavedFileChanges;

/** Frozen label (owner-approved mock): the plan-review primary when only
 *  answers are ready to send. */
export const SEND_ANSWERS_LABEL = 'Send answers';

/**
 * The feedback fields of a plan `/api/deny` body. An answers-only deny adds
 * `answersOnly: true`, and the server answers the agent with its own
 * `plan.answered` prompt (`composePlanDeniedMessage`) instead of "your plan
 * was not approved". The export goes out unframed: the prompt carries the
 * framing, so a paragraph here would say it twice. A server that predates
 * the flag ignores it and wraps the same export in its denied prompt, which
 * still reads as "revise the plan with these answers".
 */
export const planDenyFeedbackFields = (
  payload: string,
  answersOnly: boolean,
): { feedback: string; answersOnly?: true } =>
  answersOnly ? { feedback: payload, answersOnly: true } : { feedback: payload };

/**
 * What a decision that drops feedback would lose, for the "Feedback won't
 * be sent" and close warnings: `2 answers and 1 annotation`, `direct edits`,
 * or `feedback`. Answers are named separately from other annotations; with
 * no answers the wording is what it always was.
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
