import React from 'react';
import { ChevronsUpDown, FoldVertical } from 'lucide-react';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { DiffDisplayOptionsPopover } from '@plannotator/ui/components/DiffDisplayOptions';
import { DiffLayoutToggle } from '@plannotator/ui/components/DiffLayoutToggle';
import { useReviewStateOptional } from './ReviewStateContext';
import { REVIEW_ALL_FILES_PANEL_ID } from './reviewPanelTypes';
import { useEveryDiffPaneTooNarrowForSplit } from '../workspace/splitFallback';

const ICON_BUTTON = 'h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export interface ReviewDiffControlsProps {
  activePanel?: { id: string } | null;
  allChangesShown?: boolean;
}

export const ReviewDockRightActions: React.FC<ReviewDiffControlsProps> = (props) => {
  const storedDiffStyle = useConfigValue('diffStyle');
  const state = useReviewStateOptional();
  const splitTooNarrow = useEveryDiffPaneTooNarrowForSplit();

  if (state?.isCompactTouchLayout) return null;

  const diffStyle = state?.diffStyle ?? storedDiffStyle;
  const setDiffStyle = state?.onDiffStyleChange ?? ((style: 'split' | 'unified') => {
    configStore.set('diffStyle', style);
  });
  const showCollapseAll = !!state && (props.activePanel?.id === REVIEW_ALL_FILES_PANEL_ID || !!props.allChangesShown);

  const collapseAction = showCollapseAll && state ? (
    <button
      type="button"
      onClick={state.onToggleAllFilesCollapsed}
      className="w-full flex items-center gap-2 min-h-7 -mx-1 px-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      data-collapse-all-files=""
    >
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {state.allFilesAllCollapsed ? (
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
      {state.allFilesAllCollapsed ? 'Expand all files' : 'Collapse all files'}
    </button>
  ) : undefined;

  return (
    <div className="flex items-center gap-0.5" data-review-diff-controls="">
      {state && (
        <button
          type="button"
          onClick={state.onToggleAllFilesCollapsed}
          className={showCollapseAll ? ICON_BUTTON : `${ICON_BUTTON} invisible`}
          disabled={!showCollapseAll}
          aria-hidden={!showCollapseAll || undefined}
          tabIndex={showCollapseAll ? undefined : -1}
          title={state.allFilesAllCollapsed ? 'Expand all files' : 'Collapse all files'}
          aria-label={state.allFilesAllCollapsed ? 'Expand all files' : 'Collapse all files'}
          data-header-collapse-all-files={state.allFilesAllCollapsed ? 'collapsed' : 'open'}
        >
          {state.allFilesAllCollapsed ? <FoldVertical className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronsUpDown className="w-3.5 h-3.5" aria-hidden="true" />}
        </button>
      )}
      <DiffLayoutToggle value={diffStyle} onChange={setDiffStyle} splitTooNarrow={splitTooNarrow} className={ICON_BUTTON} />
      <DiffDisplayOptionsPopover
        actions={collapseAction}
        minimapOption
        triggerClassName={`${ICON_BUTTON} data-popup-open:bg-muted data-popup-open:text-foreground`}
      />
    </div>
  );
};
