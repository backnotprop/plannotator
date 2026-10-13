import { QUESTION_ANSWER_ANNOTATION_PREFIX } from '@plannotator/core/question-block';
import { AnnotationType, type Annotation } from '../types';

/** Ids of checkbox-toggle annotations: keyed by their list item's block,
 *  quoting raw markdown, and never a text highlight. */
export const CHECKBOX_ANNOTATION_PREFIX = 'ann-checkbox-';

/**
 * Whether an annotation is restored as a text highlight in the document view.
 *
 * Not: comments made in the plan diff view (`diffContext`, `blockId`
 * `diff-block-N`, drawn by the diff view), general comments, checkbox
 * toggles, and answers to `:::question` blocks (drawn by the question card).
 * Restoring any of those through the highlighter finds no text, so it would
 * be reported unanchored and its `blockId` rewritten. Every caller that
 * re-applies a stored list filters with this, and the highlighter skips the
 * same rows itself.
 */
export function annotationOwnsHighlight(
  annotation: Pick<Annotation, 'id' | 'type' | 'diffContext' | 'questionAnswer'>,
): boolean {
  return !annotation.diffContext
    && annotation.type !== AnnotationType.GLOBAL_COMMENT
    && !annotation.id.startsWith(CHECKBOX_ANNOTATION_PREFIX)
    && annotation.questionAnswer == null
    && !annotation.id.startsWith(QUESTION_ANSWER_ANNOTATION_PREFIX);
}
