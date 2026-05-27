import React, { useEffect } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useReviewState } from '../ReviewStateContext';
import { PRSummaryTab } from '../../components/PRSummaryTab';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';

/**
 * Dock panel wrapper for PR Summary — renders the existing PRSummaryTab
 * component with data from ReviewStateContext.
 */
export const ReviewPRSummaryPanel: React.FC<IDockviewPanelProps> = () => {
  const { prMetadata, prContext, isPRContextLoading, prContextError, fetchPRContext } = useReviewState();

  useEffect(() => {
    if (!prContext && !prContextError && !isPRContextLoading) fetchPRContext();
  }, [prContext, prContextError, isPRContextLoading, fetchPRContext]);

  if (!prMetadata) {
    return <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No PR metadata</div>;
  }

  if (isPRContextLoading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Loading PR summary…
      </div>
    );
  }

  if (prContextError) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-destructive text-sm">{prContextError}</div>
        <button
          type="button"
          onClick={fetchPRContext}
          className="px-2.5 py-1 rounded-md text-xs font-medium bg-muted hover:bg-muted/80 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!prContext) return null;

  return (
    <OverlayScrollArea className="h-full">
      <PRSummaryTab context={prContext} metadata={prMetadata} />
    </OverlayScrollArea>
  );
};
