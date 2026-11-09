import React from 'react';
import { DiffLayoutToggle } from '@plannotator/ui/components/DiffLayoutToggle';
import { DiffDisplayOptionsPopover } from '@plannotator/ui/components/DiffDisplayOptions';
import type { GuideHostValue } from '@plannotator/guide-viewer/host';
import { useReviewState } from '../../dock/ReviewStateContext';

/** Fold or open every guide file's diff: what the guide host's `collapseAll` takes. */
export type GuideCollapseAll = NonNullable<GuideHostValue['collapseAll']>;

/** The next Collapse all: the other way from the last one (fold, before any). */
export const nextGuideCollapseAll = (was: GuideCollapseAll | null): GuideCollapseAll => ({
  collapsed: !was?.collapsed,
  token: (was?.token ?? 0) + 1,
});

const BUTTON = 'p-1.5 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted flex items-center';

/**
 * The diff controls in the top bar while a guided review is open (approval
 * "diff-controls-headers": in a full-window review, Split/Unified sits in the
 * top bar only), after the tool icons and before Options. The guide hides the dock, and with it the dock strip's
 * controls (ReviewDockRightActions), so the guide draws its own, in the Inbox's
 * order: Split/Unified, Collapse all (more than one file), the Diff display
 * gear. Split/Unified writes the same setting as the dock strip
 * (`onDiffStyleChange`), so the choice holds everywhere. Collapse all folds or
 * opens the guide's file cards and is not remembered. A compact touch layout
 * draws none of these, as in the dock strip.
 */
export const GuideDiffControls: React.FC<{
  collapseAll: GuideCollapseAll | null;
  onCollapseAll: () => void;
}> = ({ collapseAll, onCollapseAll }) => {
  const state = useReviewState();
  if (state.isCompactTouchLayout) return null;
  const folded = collapseAll?.collapsed === true;
  return (
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
  );
};
