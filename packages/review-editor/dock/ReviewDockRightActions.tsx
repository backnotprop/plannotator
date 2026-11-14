import React from 'react';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { DiffDisplayOptionsPopover } from '@plannotator/ui/components/DiffDisplayOptions';
import { DiffLayoutToggle } from '@plannotator/ui/components/DiffLayoutToggle';
import { useReviewStateOptional } from './ReviewStateContext';
import { REVIEW_ALL_FILES_PANEL_ID, REVIEW_CODE_NAV_PANEL_ID } from './reviewPanelTypes';
import { formatShortcutBindingText, getShortcutPlatform, resolveShortcutBindings, reviewExplorerShortcuts } from '@plannotator/ui/shortcuts';

const keyHint = (action: 'navigateBack' | 'navigateForward') => {
  const binding = resolveShortcutBindings(reviewExplorerShortcuts.shortcuts[action])[0];
  return binding ? ` (${formatShortcutBindingText(binding, getShortcutPlatform())})` : '';
};

const ICON_BUTTON = 'h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export interface ReviewDiffControlsProps {
  activePanel?: { id: string } | null;
}

export const ReviewDockRightActions: React.FC<ReviewDiffControlsProps> = (props) => {
  const storedDiffStyle = useConfigValue('diffStyle');
  const state = useReviewStateOptional();

  if (state?.isCompactTouchLayout) return null;

  const diffStyle = state?.diffStyle ?? storedDiffStyle;
  const setDiffStyle = state?.onDiffStyleChange ?? ((style: 'split' | 'unified') => {
    configStore.set('diffStyle', style);
  });
  const showCollapseAll = !!state && props.activePanel?.id === REVIEW_ALL_FILES_PANEL_ID;

  const navigation = state?.navigation && props.activePanel?.id !== REVIEW_CODE_NAV_PANEL_ID ? state.navigation : null;
  const navButton = (direction: 'back' | 'forward') => {
    const enabled = direction === 'back' ? navigation!.canBack : navigation!.canForward;
    const label = direction === 'back' ? `Go back${keyHint('navigateBack')}` : `Go forward${keyHint('navigateForward')}`;
    return (
      <button
        type="button"
        onClick={direction === 'back' ? navigation!.back : navigation!.forward}
        disabled={!enabled}
        className={ICON_BUTTON}
        title={label}
        aria-label={direction === 'back' ? 'Go back' : 'Go forward'}
        data-nav-history={direction}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path d={direction === 'back' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  };

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
      {navigation && (
        <div className="flex items-center gap-0.5" role="group" aria-label="Jump history" data-jump-history="">
          {navButton('back')}
          {navButton('forward')}
        </div>
      )}
      <DiffLayoutToggle value={diffStyle} onChange={setDiffStyle} className={ICON_BUTTON} />
      <DiffDisplayOptionsPopover
        actions={collapseAction}
        minimapOption
        triggerClassName={`${ICON_BUTTON} data-popup-open:bg-muted data-popup-open:text-foreground`}
      />
    </div>
  );
};
