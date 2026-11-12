import React from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { DiffOptionsPopover } from '../components/DiffOptionsPopover';
import { DiffLayoutToggle } from '@plannotator/ui/components/DiffLayoutToggle';
import { useReviewStateOptional } from './ReviewStateContext';
import { REVIEW_ALL_FILES_PANEL_ID, REVIEW_CODE_NAV_PANEL_ID } from './reviewPanelTypes';
import { formatShortcutBindingText, getShortcutPlatform, resolveShortcutBindings, reviewExplorerShortcuts } from '@plannotator/ui/shortcuts';

const keyHint = (action: 'navigateBack' | 'navigateForward') => {
  const binding = resolveShortcutBindings(reviewExplorerShortcuts.shortcuts[action])[0];
  return binding ? ` (${formatShortcutBindingText(binding, getShortcutPlatform())})` : '';
};

export const ReviewDockRightActions: React.FC<IDockviewHeaderActionsProps> = (props) => {
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
        className="p-1.5 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
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

  return (
    <div className="flex items-center gap-1 h-full pr-2 pl-1">
      {navigation && (navigation.canBack || navigation.canForward) && (
        <div className="flex items-center" role="group" aria-label="Jump history">
          {navButton('back')}
          {navButton('forward')}
        </div>
      )}
      {showCollapseAll && state && (
        <button
          type="button"
          onClick={state.onToggleAllFilesCollapsed}
          className="p-1.5 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
          title={state.allFilesAllCollapsed ? 'Expand all files' : 'Collapse all files'}
          aria-label={state.allFilesAllCollapsed ? 'Expand all files' : 'Collapse all files'}
        >
          <svg
            className="w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
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
        </button>
      )}
      <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
        <DiffLayoutToggle
          value={diffStyle}
          onChange={setDiffStyle}
          className="px-1.5 py-1 rounded-md text-foreground transition-colors hover:bg-background flex items-center"
        />
        <div className="w-px h-4 bg-border/60 mx-0.5" />
        <DiffOptionsPopover />
      </div>
    </div>
  );
};
