import React, { useLayoutEffect } from 'react';

export const GeneratedFileNotice: React.FC<{
  additions: number;
  deletions: number;
  onExpand: () => void;
  onHeightChange?: () => void;
}> = ({ additions, deletions, onExpand, onHeightChange }) => {
  useLayoutEffect(() => {
    onHeightChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <button
      type="button"
      data-pn-generated-collapsed-notice=""
      onClick={(e) => {
        e.stopPropagation();
        onExpand();
      }}
      className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs leading-relaxed text-muted-foreground border-b border-border bg-muted/30 hover:bg-muted/60 transition-colors cursor-pointer"
      title="Expand diff"
    >
      <span>Generated file collapsed</span>
      <span className="flex items-center gap-1.5 font-mono">
        {additions > 0 && <span className="text-success">+{additions}</span>}
        {deletions > 0 && <span className="text-destructive">-{deletions}</span>}
      </span>
      <span className="ml-auto underline decoration-dotted underline-offset-2">
        Click to view
      </span>
    </button>
  );
};
