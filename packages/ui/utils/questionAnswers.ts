/**
 * Glue between `:::question` answers (`@plannotator/core/question-block`)
 * and the UI's `Annotation` list. An answer is ONE annotation carrying
 * `questionAnswer`, id `ann-question-<key>`, so drafts, reload, the panel and
 * host persistence carry it with no second store. These helpers are pure; a
 * host (or Plannotator's editor) calls `upsertQuestionAnswerAnnotation` from
 * the Viewer's `onAnswerQuestion` and stores the returned list.
 */
import {
  buildQuestionAnswerAnnotation,
  isQuestionAnswerEmpty,
  parseQuestionAnswer,
  questionAnswerAnnotationId,
  type QuestionAnswer,
} from '@plannotator/core/question-block';
import { AnnotationType, type Annotation } from '../types';

/** The answer annotation for a question block, typed for the UI. */
export const questionAnswerToAnnotation = (
  blockId: string,
  answer: QuestionAnswer,
  createdA?: number,
): Annotation => {
  const record = buildQuestionAnswerAnnotation(blockId, answer, createdA);
  return { ...record, type: AnnotationType.COMMENT };
};

/** Valid answers in an annotation list, keyed by question key (first wins).
 *  Malformed `questionAnswer` values are skipped, never thrown on. */
export const collectQuestionAnswers = (annotations: ReadonlyArray<Annotation>): Map<string, QuestionAnswer> => {
  const out = new Map<string, QuestionAnswer>();
  for (const ann of annotations) {
    if (ann.questionAnswer == null) continue;
    const answer = parseQuestionAnswer(ann.questionAnswer);
    if (answer && !out.has(answer.key)) out.set(answer.key, answer);
  }
  return out;
};

/** Whether an annotation is a question answer (validated). */
export const isQuestionAnswerAnnotation = (ann: Pick<Annotation, 'questionAnswer'>): boolean =>
  ann.questionAnswer != null && parseQuestionAnswer(ann.questionAnswer) !== null;

/**
 * Apply one `onAnswerQuestion(blockId, answer, key)` call to an annotation
 * list: replace the question's answer annotation in place (keeping its
 * `createdA` and position), append it when new, or remove it when `answer`
 * is null or empty. Returns the same array when nothing changed.
 */
export const upsertQuestionAnswerAnnotation = (
  annotations: ReadonlyArray<Annotation>,
  blockId: string,
  answer: QuestionAnswer | null,
  key: string,
): Annotation[] => {
  const id = questionAnswerAnnotationId(key);
  const index = annotations.findIndex((a) => a.id === id);
  const valid = answer ? parseQuestionAnswer(answer) : null;
  if (!valid || isQuestionAnswerEmpty(valid)) {
    if (index === -1) return annotations as Annotation[];
    return annotations.filter((_, i) => i !== index);
  }
  const existing = index === -1 ? undefined : annotations[index];
  const next = questionAnswerToAnnotation(blockId, valid, existing?.createdA);
  if (existing?.author) next.author = existing.author;
  if (index === -1) return [...annotations, next];
  const copy = annotations.slice();
  copy[index] = next;
  return copy;
};
