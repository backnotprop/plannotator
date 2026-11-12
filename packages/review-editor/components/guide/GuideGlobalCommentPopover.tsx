import React from 'react';
import { CommentPopover, restoreCommentDraft } from '@plannotator/ui/components/CommentPopover';

export function GuideGlobalCommentPopover({
  anchorEl,
  jobId,
  onAdd,
  onClose,
}: {
  anchorEl: HTMLElement;
  jobId: string;
  onAdd: (text: string) => boolean | void;
  onClose: () => void;
}) {
  const draftKey = `review-guide-global:${jobId}`;
  return (
    <CommentPopover
      anchorEl={anchorEl}
      contextText=""
      isGlobal
      allowImages={false}
      draftKey={draftKey}
      onSubmit={(text) => {
        onClose();
        const trimmed = text.trim();
        if (trimmed && onAdd(trimmed) === false) restoreCommentDraft(draftKey, text);
      }}
      onClose={onClose}
    />
  );
}
