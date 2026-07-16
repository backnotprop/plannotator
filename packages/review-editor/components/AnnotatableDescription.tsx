import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { RenderedMarkdown } from '@plannotator/ui/components/RenderedMarkdown';
import { CommentPopover } from '@plannotator/ui/components/CommentPopover';
import { useAnnotationHighlighter } from '@plannotator/ui/hooks/useAnnotationHighlighter';
import { useReviewState } from '../dock/ReviewStateContext';

/**
 * The PR description, made annotatable. Mounts the shared text-anchored
 * annotation engine on the rendered markdown in **comment mode**: selecting
 * text opens the comment box directly (no toolbar / quick-labels / redline).
 * Comments are owned by App (`descriptionAnnotations`) via `ReviewStateContext`
 * and surface in the Annotations sidebar under "PR description".
 *
 * Memoized so it re-renders only when the body or its annotations change — this
 * keeps React from reconciling away the web-highlighter marks on unrelated
 * parent re-renders (they're re-applied idempotently below regardless).
 */
export const AnnotatableDescription = React.memo(function AnnotatableDescription({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  const {
    descriptionAnnotations,
    selectedDescriptionAnnotationId,
    onAddDescriptionAnnotation,
    onSelectDescriptionAnnotation,
    onAskAIForDescription,
  } = useReviewState();

  const containerRef = useRef<HTMLDivElement>(null);

  const hook = useAnnotationHighlighter({
    containerRef,
    annotations: descriptionAnnotations,
    onAddAnnotation: onAddDescriptionAnnotation,
    onSelectAnnotation: onSelectDescriptionAnnotation,
    selectedAnnotationId: selectedDescriptionAnnotationId,
    mode: 'comment',
  });

  // Reconcile marks off the store: apply new ones (idempotent) and remove marks
  // for annotations that were deleted (e.g. from the sidebar). Re-runs on body
  // change so highlights re-bind after the description content updates.
  const prevIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(descriptionAnnotations.map(a => a.id));
    for (const id of prevIdsRef.current) {
      if (!ids.has(id)) hook.removeHighlight(id);
    }
    hook.applyAnnotations(descriptionAnnotations);
    prevIdsRef.current = ids;
  }, [descriptionAnnotations, markdown]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={containerRef}>
      <RenderedMarkdown markdown={markdown} className={className} />

      {hook.commentPopover &&
        createPortal(
          <CommentPopover
            anchorEl={hook.commentPopover.anchorEl}
            contextText={hook.commentPopover.contextText}
            initialText={hook.commentPopover.initialText}
            isGlobal={false}
            allowImages={false}
            onSubmit={hook.handleCommentSubmit}
            onClose={hook.handleCommentClose}
            onAskAI={onAskAIForDescription}
            askAIContext={{
              kind: 'selection',
              label: 'PR description',
              text: hook.commentPopover.selectedText ?? hook.commentPopover.contextText,
            }}
          />,
          document.body,
        )}
    </div>
  );
});
