import React, { useEffect } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useReviewState } from '../ReviewStateContext';
import { PRCommentsTab } from '../../components/PRCommentsTab';

/**
 * Dock panel wrapper for PR Comments.
 */
export const ReviewPRCommentsPanel: React.FC<IDockviewPanelProps> = () => {
  const { prContext, isPRContextLoading, prContextError, fetchPRContext, platformUser } = useReviewState();

  useEffect(() => {
    if (!prContext && !prContextError && !isPRContextLoading) fetchPRContext();
  }, [prContext, prContextError, isPRContextLoading, fetchPRContext]);

  if (isPRContextLoading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Loading comments…
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
    <div className="h-full overflow-hidden">
      <PRCommentsTab context={prContext} platformUser={platformUser} />
    </div>
  );
};
