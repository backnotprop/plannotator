import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import type { IndexedQuestion, QuestionAnswer } from '@plannotator/core/question-block';
import { sameAnswerParts, type QuestionAcceptBehavior } from '@plannotator/ui/components/blocks/QuestionBlock';

export function useAcceptedUndo(message: InboxMessageWire, readOnly: boolean, answers: ReadonlyMap<string, QuestionAnswer>, footerFor: (key: string) => string | null) {
  const footerRef = useRef(footerFor);
  footerRef.current = footerFor;
  const [acceptedUndo, setAcceptedUndo] = useState<{ key: string; answer: QuestionAnswer; undo: () => void } | null>(null);
  const undoState = acceptedUndo ? message.questions?.find((q) => q.key === acceptedUndo.key)?.state : undefined;
  const undoCurrent =
    acceptedUndo !== null &&
    !readOnly &&
    (undoState === undefined || undoState === 'open' || undoState === 'picked') &&
    !!answers.get(acceptedUndo.key) &&
    sameAnswerParts(answers.get(acceptedUndo.key)!, acceptedUndo.answer);
  useEffect(() => {
    if (acceptedUndo && !undoCurrent) setAcceptedUndo(null);
  }, [acceptedUndo, undoCurrent]);
  const renderFooter = useCallback(
    (question: IndexedQuestion) => {
      const text = footerRef.current(question.question.key);
      const undo = undoCurrent && acceptedUndo?.key === question.question.key ? acceptedUndo : null;
      if (!text && !undo) return null;
      return (
        <span className="ib-qfoot-st">
          {text}
          {undo && (
            <button
              type="button"
              className="ib-qfoot-undo"
              onClick={() => {
                setAcceptedUndo(null);
                undo.undo();
              }}
            >
              Undo
            </button>
          )}
        </span>
      );
    },
    [footerFor, acceptedUndo, undoCurrent],
  );
  const acceptBehavior = useMemo<QuestionAcceptBehavior>(
    () => ({
      asideWhileTyping: true,
      keepOther: true,
      onAccepted: (undo, accepted) => {
        setAcceptedUndo({ ...accepted, undo });
      },
    }),
    [],
  );
  return { renderFooter, acceptBehavior };
}
