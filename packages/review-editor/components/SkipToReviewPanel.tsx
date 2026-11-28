import React from 'react';

export const SkipToReviewPanel: React.FC<{ onSkip: () => void }> = ({ onSkip }) => (
  <button
    type="button"
    onClick={onSkip}
    data-skip-to-review-panel=""
    className="absolute left-2 top-2 z-50 -translate-y-[200%] rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus-visible:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    Skip to review panel
  </button>
);
