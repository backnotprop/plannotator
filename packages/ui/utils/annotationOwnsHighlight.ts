import { QUESTION_ANSWER_ANNOTATION_PREFIX } from '@plannotator/core/question-block';
import { AnnotationType, type Annotation } from '../types';

/**
 * Ids of checkbox-toggle annotations: keyed by their list item's block, quoting raw markdown,
 * and never a text highlight.
 */
export const CHECKBOX_ANNOTATION_PREFIX = 'ann-checkbox-';

/** Whether an annotation is restored as a text highlight in the document view. */
export function annotationOwnsHighlight(
  annotation: Pick<Annotation, 'id' | 'type' | 'diffContext' | 'questionAnswer'> & Partial<Pick<Annotation, 'imageRegion'>>,
): boolean {
  return !annotation.diffContext
    && annotation.type !== AnnotationType.GLOBAL_COMMENT
    && !annotation.id.startsWith(CHECKBOX_ANNOTATION_PREFIX)
    && annotation.questionAnswer == null
    && annotation.imageRegion == null
    && !annotation.id.startsWith(QUESTION_ANSWER_ANNOTATION_PREFIX);
}
