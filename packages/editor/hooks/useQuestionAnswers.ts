import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { questionAnswerAnnotationId, type QuestionAnswer } from '@plannotator/shared/question-block';
import type { Annotation } from '@plannotator/ui/types';
import type { UndoHistoryApi } from '@plannotator/ui/hooks/useUndoHistory';
import type { CollectionMutation } from '@plannotator/ui/utils/undoHistory';
import { getIdentity } from '@plannotator/ui/utils/identity';
import { upsertQuestionAnswerAnnotation } from '@plannotator/ui/utils/questionAnswers';

/**
 * Typing in a question's free text, "Other…" or note field folds into ONE
 * history entry per burst: a keystroke within this many milliseconds of the
 * previous one on the same question extends the entry instead of adding one.
 */
export const QUESTION_TYPING_BURST_MS = 1000;

interface Located {
  annotation: Annotation | undefined;
  index: number;
}

const answerOf = (annotation: Annotation | undefined): QuestionAnswer | undefined =>
  annotation?.questionAnswer as QuestionAnswer | undefined;

const sameAnswer = (a: Annotation | undefined, b: Annotation | undefined): boolean =>
  JSON.stringify(answerOf(a) ?? null) === JSON.stringify(answerOf(b) ?? null);

const sameList = (a: readonly string[] = [], b: readonly string[] = []): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** A change to the typed fields only (free text, Other, note). A single
 *  question's Other clears the picked choice as the first key lands, which
 *  is still typing. Picks, skips and Accept recommended on a choice question
 *  are not typing: each gets its own entry. */
export const isQuestionTypingChange = (
  before: QuestionAnswer | undefined,
  after: QuestionAnswer | undefined,
): boolean => {
  const textual = (before?.text ?? '') !== (after?.text ?? '')
    || (before?.other ?? '') !== (after?.other ?? '')
    || (before?.note ?? '') !== (after?.note ?? '');
  if (!textual) return false;
  if (!!before?.skipped !== !!after?.skipped) return false;
  if (sameList(before?.selected, after?.selected)) return true;
  return (after?.selected.length ?? 0) === 0 && !!after?.other?.trim();
};

/** The one collection mutation that turns `from` into `to` for the answer's
 *  annotation, or null when they are the same answer. */
export const questionAnswerMutation = (from: Located, to: Located): CollectionMutation<Annotation> | null => {
  if (!from.annotation && !to.annotation) return null;
  if (!to.annotation) return { kind: 'delete', item: from.annotation!, index: from.index };
  if (!from.annotation) return { kind: 'add', item: to.annotation, index: to.index };
  if (sameAnswer(from.annotation, to.annotation)) return null;
  return { kind: 'edit', before: from.annotation, after: to.annotation };
};

interface Burst<TAction> {
  key: string;
  origin: Located;
  action: TAction;
  at: number;
  typing: boolean;
}

interface Options<TAction> {
  setAnnotations: Dispatch<SetStateAction<Annotation[]>>;
  annotationsRef: MutableRefObject<Annotation[]>;
  history: Pick<UndoHistoryApi<TAction>, 'record' | 'replaceLast'>;
  /** Wrap an answer's mutation as the host's history action. */
  toAction: (mutation: CollectionMutation<Annotation>) => TAction;
  readOnly?: boolean;
  now?: () => number;
}

/**
 * The Viewer's `onAnswerQuestion` for Plannotator: upserts or removes the
 * answer's annotation (`ann-question-<key>`) and records the change in the
 * annotation undo history, so Mod+Z / Mod+Shift+Z step through answers like
 * any other annotation. Typing folds into one entry per burst; a change that
 * returns the question to where its burst began (the double-click revert in
 * the card) drops the entry instead of adding one.
 */
export function useQuestionAnswers<TAction>({
  setAnnotations,
  annotationsRef,
  history,
  toAction,
  readOnly = false,
  now = Date.now,
}: Options<TAction>) {
  const burstRef = useRef<Burst<TAction> | null>(null);
  const optionsRef = useRef({ history, toAction, readOnly, now });
  optionsRef.current = { history, toAction, readOnly, now };

  return useCallback((blockId: string, answer: QuestionAnswer | null, key: string) => {
    const opts = optionsRef.current;
    if (opts.readOnly) return;
    const current = annotationsRef.current;
    const id = questionAnswerAnnotationId(key);
    const beforeIndex = current.findIndex((a) => a.id === id);
    const before: Located = { annotation: beforeIndex === -1 ? undefined : current[beforeIndex], index: beforeIndex === -1 ? current.length : beforeIndex };

    let next = upsertQuestionAnswerAnnotation(current, blockId, answer, key);
    if (next === current) return;
    const afterIndex = next.findIndex((a) => a.id === id);
    if (afterIndex !== -1 && !next[afterIndex].author) {
      next = next.slice();
      next[afterIndex] = { ...next[afterIndex], author: getIdentity() };
    }
    const after: Located = { annotation: afterIndex === -1 ? undefined : next[afterIndex], index: afterIndex === -1 ? next.length : afterIndex };
    if (!before.annotation && !after.annotation) return;

    annotationsRef.current = next;
    setAnnotations(next);

    const at = opts.now();
    const typing = isQuestionTypingChange(answerOf(before.annotation), answerOf(after.annotation));
    const burst = burstRef.current;
    if (burst && burst.key === key && at - burst.at <= QUESTION_TYPING_BURST_MS) {
      const reverted = sameAnswer(burst.origin.annotation, after.annotation);
      if (reverted || (typing && burst.typing)) {
        const mutation = questionAnswerMutation(burst.origin, after);
        const action = mutation ? opts.toAction(mutation) : null;
        if (opts.history.replaceLast(burst.action, action)) {
          burstRef.current = action ? { ...burst, action, at } : null;
          return;
        }
      }
    }

    const mutation = questionAnswerMutation(before, after);
    if (!mutation) return;
    const action = opts.toAction(mutation);
    opts.history.record(action);
    burstRef.current = { key, origin: before, action, at, typing };
  }, [annotationsRef, setAnnotations]);
}
