import React, { useLayoutEffect } from 'react';
import { OVERSIZED_REVIEW_STUB_LIMIT_LABEL } from '@plannotator/shared/diff-paths';

/**
 * Why an oversized file's card has no diff in it.
 *
 * Files over the review size cap are replaced server-side by a stub patch
 * (`buildOversizedTrackedStub`), which renders as an empty body. Without this
 * line the card is a bare header with no counts and no reason, which reads as a
 * broken diff rather than a deliberate limit.
 */
export const OversizedFileNotice: React.FC<{
  /** Re-measure hook for the virtualized all-files host (custom-header portal
   *  heights are not auto-observed). */
  onHeightChange?: () => void;
}> = ({ onHeightChange }) => {
  // Layout effect (before paint) so the host re-measures without a one-frame
  // overlap with the content below.
  useLayoutEffect(() => {
    onHeightChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      data-oversized-file-notice=""
      className="px-4 py-2 text-xs leading-relaxed text-muted-foreground border-b border-border bg-muted/30"
    >
      This file is over the {OVERSIZED_REVIEW_STUB_LIMIT_LABEL} review limit, so
      its contents were not diffed. Only this stub is shown.
    </div>
  );
};
