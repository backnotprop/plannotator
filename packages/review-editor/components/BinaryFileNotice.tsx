import React, { useLayoutEffect } from 'react';

/**
 * Says why a file's card has no diff in it.
 *
 * A patch chunk with a binary marker and no hunks renders as an empty body:
 * the card is a bare header with no counts and no reason, which reads as a
 * broken diff. That shape covers genuine binary files and files the review
 * core declined to read, so the copy commits to neither cause.
 */
export const BinaryFileNotice: React.FC<{
  /** Re-measure hook for the virtualized all-files host, whose custom-header
   *  slot heights are not auto-observed. */
  onHeightChange?: () => void;
}> = ({ onHeightChange }) => {
  // Before paint, so the host re-measures without a one-frame overlap with the
  // content below.
  useLayoutEffect(() => {
    onHeightChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      data-binary-file-notice=""
      className="px-4 py-2 text-xs leading-relaxed text-muted-foreground border-b border-border bg-muted/30"
    >
      Binary or oversized file, content not shown.
    </div>
  );
};
