import React, { useLayoutEffect } from 'react';
import {
  OVERSIZED_REVIEW_STUB_LIMIT_LABEL,
  UNTRACKED_CAP_BYTES_LABEL,
  UNTRACKED_CAP_FILES_LABEL,
  type ReviewStubReason,
} from '@plannotator/shared/diff-paths';

/**
 * Why an oversized file's card has no diff in it.
 *
 * Files over the review size cap are replaced server-side by a stub patch
 * (`buildOversizedTrackedStub`), which renders as an empty body. Without this
 * line the card is a bare header with no counts and no reason, which reads as a
 * broken diff rather than a deliberate limit. An untracked file the review
 * listed but did not read (past the untracked file or byte caps) says that
 * instead (`reason="untracked-left-out"`).
 */
export const OversizedFileNotice: React.FC<{
  /** Re-measure hook for the virtualized all-files host (custom-header portal
   *  heights are not auto-observed). */
  onHeightChange?: () => void;
  reason?: ReviewStubReason;
}> = ({ onHeightChange, reason = 'oversized' }) => {
  // Layout effect (before paint) so the host re-measures without a one-frame
  // overlap with the content below.
  useLayoutEffect(() => {
    onHeightChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      data-oversized-file-notice={reason}
      className="px-4 py-2 text-xs leading-relaxed text-muted-foreground border-b border-border bg-muted/30"
    >
      {reason === 'untracked-left-out' ? (
        <>
          This untracked file was left out: a review reads at most{' '}
          {UNTRACKED_CAP_FILES_LABEL} untracked files and {UNTRACKED_CAP_BYTES_LABEL} of
          their contents. Add generated folders to .gitignore to keep them out.
        </>
      ) : (
        <>
          This file is over the {OVERSIZED_REVIEW_STUB_LIMIT_LABEL} review limit, so
          its contents were not diffed. Only this stub is shown.
        </>
      )}
    </div>
  );
};
