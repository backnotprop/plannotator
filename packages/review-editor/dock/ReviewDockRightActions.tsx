import React from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { DiffOptionsPopover } from '../components/DiffOptionsPopover';
import { useReviewStateOptional } from './ReviewStateContext';
import { REVIEW_ALL_FILES_PANEL_ID, REVIEW_CODE_NAV_PANEL_ID } from './reviewPanelTypes';
import { formatShortcutBindingText, getShortcutPlatform, resolveShortcutBindings, reviewExplorerShortcuts } from '@plannotator/ui/shortcuts';

const keyHint = (action: 'navigateBack' | 'navigateForward') => {
  const binding = resolveShortcutBindings(reviewExplorerShortcuts.shortcuts[action])[0];
  return binding ? ` (${formatShortcutBindingText(binding, getShortcutPlatform())})` : '';
};

/**
 * Split/Unified diff toggle + options, pinned to the right of the dock tab strip
 * (dockview's `rightHeaderActionsComponent`). Stays visible while the tabs
 * scroll. Desktop reads/writes the global `configStore`; compact-touch review
 * shells provide a session-only style through review state so opening a review
 * on a phone never changes the user's desktop preference.
 *
 * Rendered per group; for now it shows in every group's tab strip (the diff
 * setting is global). Scoping it to the diff-bearing group is a later refinement
 * if splitting proves it noisy.
 */
export const ReviewDockRightActions: React.FC<IDockviewHeaderActionsProps> = (props) => {
  const storedDiffStyle = useConfigValue('diffStyle');
  const state = useReviewStateOptional();

  // Dockview's tab strip is intentionally only 33px tall. Compact-touch
  // controls need a 44px target, so placing them here makes their focus and
  // hit geometry overlap the first file header below. Keep this dense control
  // cluster on fine-pointer layouts; compact review exposes display settings
  // through the ordinary Settings surface instead.
  if (state?.isCompactTouchLayout) return null;

  const diffStyle = state?.diffStyle ?? storedDiffStyle;
  const setDiffStyle = state?.onDiffStyleChange ?? ((style: 'split' | 'unified') => {
    configStore.set('diffStyle', style);
  });
  // Collapse/expand-all files — only meaningful (and only shown) when this
  // group's active panel is the All files view.
  const showCollapseAll = !!state && props.activePanel?.id === REVIEW_ALL_FILES_PANEL_ID;

  // Back / forward across jumps, in the code's group (not the references panel's).
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
        <button
          onClick={() => setDiffStyle('split')}
          className={`px-2 py-1 text-xs rounded-md transition-colors ${
            diffStyle === 'split'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Split
        </button>
        <button
          onClick={() => setDiffStyle('unified')}
          className={`px-2 py-1 text-xs rounded-md transition-colors ${
            diffStyle === 'unified'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Unified
        </button>
        <div className="w-px h-4 bg-border/60 mx-0.5" />
        <DiffOptionsPopover
          diffStyle={diffStyle}
          onDiffStyleChange={setDiffStyle}
        />
      </div>
    </div>
  );
};
