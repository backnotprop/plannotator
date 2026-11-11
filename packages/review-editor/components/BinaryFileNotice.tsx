import React, { useLayoutEffect } from 'react';

export const BinaryFileNotice: React.FC<{
  onHeightChange?: () => void;
}> = ({ onHeightChange }) => {
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
