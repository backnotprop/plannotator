import React from 'react';
import type { AutoViewedNoticeState } from '../hooks/useAutoViewedNotice';

export const AutoViewedNotice: React.FC<{ notice: AutoViewedNoticeState; onTurnOff: () => void }> = ({ notice, onTurnOff }) => {
  if (!notice) return null;
  return (
    <p role="status" data-auto-viewed-notice={notice} className="px-2 pb-1 text-xs leading-4 text-muted-foreground">
      {notice === 'intro' ? (
        <>
          Viewed as you scroll ·{' '}
          <button type="button" onClick={onTurnOff} className="rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            Turn off
          </button>
        </>
      ) : (
        'Viewed as you scroll is off. Turn it on from the list options.'
      )}
    </p>
  );
};
