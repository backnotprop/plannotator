import React from 'react';
import { DiffLayoutToggle } from '@plannotator/ui/components/DiffLayoutToggle';
import { DiffDisplayOptionsPopover } from '@plannotator/ui/components/DiffDisplayOptions';
import type { GuideHostValue } from '@plannotator/guide-viewer/host';
import { useReviewState } from '../../dock/ReviewStateContext';

export type GuideCollapseAll = NonNullable<GuideHostValue['collapseAll']>;

export const nextGuideCollapseAll = (was: GuideCollapseAll | null): GuideCollapseAll => ({
  collapsed: !was?.collapsed,
  token: (was?.token ?? 0) + 1,
});

const BUTTON = 'p-1.5 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted flex items-center';

export const GuideDiffControls: React.FC<{
  collapseAll: GuideCollapseAll | null;
  onCollapseAll: () => void;
}> = ({ collapseAll, onCollapseAll }) => {
  const state = useReviewState();
  if (state.isCompactTouchLayout) return null;
  const folded = collapseAll?.collapsed === true;
  return (
    <>
      <div className="flex items-center gap-1 lg:gap-2" role="group" aria-label="Diff display" data-guide-diff-controls="">
        <DiffLayoutToggle value={state.diffStyle} onChange={state.onDiffStyleChange} className={BUTTON} />
        {state.files.length > 1 && (
          <button
            type="button"
            onClick={onCollapseAll}
            className={BUTTON}
            title={folded ? 'Expand all files' : 'Collapse all files'}
            aria-label={folded ? 'Expand all files' : 'Collapse all files'}
            data-guide-collapse-all={folded ? 'collapsed' : 'open'}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {folded ? (
                <>
                  <path d="M7 9l5-5 5 5" />
                  <path d="M7 15l5 5 5-5" />
                </>
              ) : (
                <>
                  <path d="M7 4l5 5 5-5" />
                  <path d="M7 20l5-5 5 5" />
                </>
              )}
            </svg>
          </button>
        )}
        <DiffDisplayOptionsPopover triggerClassName={`${BUTTON} data-popup-open:bg-muted data-popup-open:text-foreground`} triggerTitleSide="bottom" />
      </div>
      <div className="w-px h-5 bg-border/50 mx-1 hidden lg:block" data-guide-diff-controls-divider="" />
    </>
  );
};
