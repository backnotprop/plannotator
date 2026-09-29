import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { questionAnswerAnnotationId, type QuestionAnswer } from '@plannotator/shared/question-block';
import type { Annotation } from '@plannotator/ui/types';
import { getIdentity } from '@plannotator/ui/utils/identity';
import { upsertQuestionAnswerAnnotation } from '@plannotator/ui/utils/questionAnswers';

/**
 * MINIMAL wiring for `:::question` answers (PR 1 of the question/answer
 * feature): the Viewer's `onAnswerQuestion` upserts or removes the answer's
 * annotation in the document's annotation list, so answers draw, autosave
 * with the draft and export. Undo history, the decision-control progress
 * chip, the "Send answers" framing and the Questions panel section are the
 * follow-up editor PR.
 */
export function useQuestionAnswers(
  setAnnotations: Dispatch<SetStateAction<Annotation[]>>,
  annotationsRef: MutableRefObject<Annotation[]>,
) {
  return useCallback((blockId: string, answer: QuestionAnswer | null, key: string) => {
    setAnnotations((current) => {
      let next = upsertQuestionAnswerAnnotation(current, blockId, answer, key);
      const id = questionAnswerAnnotationId(key);
      const index = next.findIndex((a) => a.id === id);
      if (index !== -1 && !next[index].author) {
        next = next.slice();
        next[index] = { ...next[index], author: getIdentity() };
      }
      annotationsRef.current = next;
      return next;
    });
  }, [annotationsRef, setAnnotations]);
}
