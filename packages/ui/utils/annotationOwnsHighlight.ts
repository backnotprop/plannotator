import { QUESTION_ANSWER_ANNOTATION_PREFIX } from '@plannotator/core/question-block';
import { AnnotationType, type Annotation } from '../types';

export const CHECKBOX_ANNOTATION_PREFIX = 'ann-checkbox-';

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
