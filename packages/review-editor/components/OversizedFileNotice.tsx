import React, { useLayoutEffect } from 'react';
import { OVERSIZED_REVIEW_STUB_LIMIT_LABEL } from '@plannotator/shared/diff-paths';

export const OversizedFileNotice: React.FC<{
  onHeightChange?: () => void;
}> = ({ onHeightChange }) => {
  useLayoutEffect(() => {
    onHeightChange?.();
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
