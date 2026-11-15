/** MessageBody's comments (parts/MessageBody/MessageBody.tsx). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewerHandle } from '@plannotator/ui/components/Viewer';
import type { Annotation, Block } from '@plannotator/ui/types';
import { messageSideSource } from '../../ask/sideSource';
import { useSideButton } from '../../ask/sideButton';
import type { SelectionActionContext } from '@plannotator/ui/utils/selectionActions';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import type { MessageBodyProps } from './types';
import { NO_ANNOTATIONS } from '../../thread/helpers';

/** The person's comments on the body's text: drawn as highlights, a new one saved, Side, and a pick passed on. */
export function useBodyComments({ comments, message, blocks, onPick }: Pick<MessageBodyProps, 'comments' | 'message' | 'onPick'> & { blocks: Block[] }) {
  // ── Comments on the text (approval "inbox-message-comments") ──────────────
  // The highlights are drawn once per mount for the comments already saved;
  // a new comment paints itself (the selection becomes its mark), and one the
  // person removes elsewhere (the reply box's list) leaves the text.
  const viewerRef = useRef<ViewerHandle>(null);
  const savedComments = comments?.annotations;
  const commentList = useMemo<Annotation[]>(() => (savedComments ? [...savedComments] : NO_ANNOTATIONS), [savedComments]);
  // A diagram's numbered badge, in the message or its popout, shows its comment selected. A text highlight's press is
  // openHighlight's, and reaches here too, so it is passed over.
  const [selectedBadge, setSelectedBadge] = useState<string | null>(null);
  const selectBadge = useCallback(
    (id: string | null) => {
      if (id !== null && !commentList.find((comment) => comment.id === id)?.diagramAnchor) return;
      setSelectedBadge((current) => (current === id ? null : id));
    },
    [commentList],
  );
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const painted = useRef<Set<string>>(new Set());
  const addComment = useCallback((annotation: Annotation) => {
    painted.current.add(annotation.id);
    void commentsRef.current?.onSave(annotation).then((saved) => {
      if (saved) return;
      painted.current.delete(annotation.id);
      viewerRef.current?.removeHighlight(annotation.id);
    });
  }, []);
  const restoreReport = useCallback((report: { attempted: readonly string[]; unanchored: readonly string[] }) => commentsRef.current?.onUnanchored?.(report), []);
  // Side (ask/useInboxAsk.tsx): read through refs, as every kept closure here (#2948): naming `comments`, the message
  // or its blocks in a closure would let this body's kept closures hold a render of the whole thread view per read.
  const sideButton = useSideButton();
  const sideFrom = useRef({ message, blocks, annotations: commentList });
  sideFrom.current = { message, blocks, annotations: commentList };
  const side = useCallback((text: string, context: SelectionActionContext) => {
    const from = sideFrom.current;
    commentsRef.current?.onSide?.(text, messageSideSource(from.message, { selected: text, blockId: context.blockId, blocks: from.blocks, annotations: from.annotations }));
  }, []);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const answerQuestion = useCallback((_blockId: string, answer: QuestionAnswer | null, key: string) => pickRef.current(key, answer), []);
  const commentsOn = comments !== undefined;
  useEffect(() => {
    if (!commentsOn) return;
    const ids = new Set(commentList.map((a) => a.id));
    for (const id of [...painted.current]) {
      if (ids.has(id)) continue;
      painted.current.delete(id);
      viewerRef.current?.removeHighlight(id);
    }
    const fresh = commentList.filter((a) => !painted.current.has(a.id) && annotationOwnsHighlight(a));
    if (fresh.length === 0) return;
    for (const a of fresh) painted.current.add(a.id);
    // After the Viewer's highlighter is ready (the attachment pane's rule).
    let done = false;
    const frame = requestAnimationFrame(() => {
      done = true;
      viewerRef.current?.applySharedAnnotations(fresh);
      commentsRef.current?.onPainted?.();
    });
    return () => {
      if (done) return;
      cancelAnimationFrame(frame);
      for (const a of fresh) painted.current.delete(a.id);
    };
  }, [commentsOn, commentList]);
  return { viewerRef, commentList, selectedBadge, selectBadge, commentsRef, addComment, restoreReport, sideButton, side, answerQuestion };
}
