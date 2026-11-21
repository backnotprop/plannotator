import React from 'react';
import { CommentPopover, restoreCommentDraft } from '@plannotator/ui/components/CommentPopover';

/** The guide's global comment composer. A refused add (`false`) puts the words back as the draft, so the next open shows them. */
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
      // The export prints a global comment's words only.
      allowImages={false}
      // The words typed survive a close (Escape, a click outside) until they are saved.
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
