import React, { useLayoutEffect } from 'react';

/**
 * What a collapsed generated file's card shows instead of an empty body
 * (#1317). A default-collapsed lockfile would otherwise render as a bare
 * file header, indistinguishable from a failed render — this strip states
 * the fold is intentional, carries the +/- counts, and expands on click
 * through the same collapse-report funnel as the header chevron.
 *
 * Styled like the other below-header notices (OversizedFileNotice,
 * BinaryFileNotice): muted strip, existing tokens only.
 */
export const GeneratedFileNotice: React.FC<{
  additions: number;
  deletions: number;
  /** Expand the file — the SAME toggle path the chevron uses, so the
   *  expansion reports through reportFileCollapsed and survives remounts. */
  onExpand: () => void;
  /** Re-measure hook for the virtualized all-files host (custom-header portal
   *  heights are not auto-observed). */
  onHeightChange?: () => void;
}> = ({ additions, deletions, onExpand, onHeightChange }) => {
  // Layout effect (before paint) so the host re-measures without a one-frame
  // overlap with the content below.
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
