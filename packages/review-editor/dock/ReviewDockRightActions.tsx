import React from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import { DiffOptionsPopover } from '../components/DiffOptionsPopover';
import { useReviewStateOptional } from './ReviewStateContext';
import { REVIEW_ALL_FILES_PANEL_ID } from './reviewPanelTypes';

/**
 * Split/Unified diff toggle + options, pinned to the right of the dock tab strip
 * (dockview's `rightHeaderActionsComponent`). Stays visible while the tabs
 * scroll. Reads/writes the global `configStore` plus the review state context
 * (for the all-files collapse toggle).
 *
 * Rendered per group; for now it shows in every group's tab strip (the diff
 * setting is global). Scoping it to the diff-bearing group is a later refinement
 * if splitting proves it noisy.
 */
export const ReviewDockRightActions: React.FC<IDockviewHeaderActionsProps> = (props) => {
  const diffStyle = useConfigValue('diffStyle');
  const state = useReviewStateOptional();
  // Collapse/expand-all files — only meaningful (and only shown) when this
  // group's active panel is the All files view.
  const showCollapseAll = !!state && props.activePanel?.id === REVIEW_ALL_FILES_PANEL_ID;

  return (
    <div className="flex items-center gap-1 h-full pr-2 pl-1">
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
          onClick={() => configStore.set('diffStyle', 'split')}
          className={`px-2 py-1 text-xs rounded-md transition-colors ${
            diffStyle === 'split'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Split
        </button>
        <button
          onClick={() => configStore.set('diffStyle', 'unified')}
          className={`px-2 py-1 text-xs rounded-md transition-colors ${
            diffStyle === 'unified'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Unified
        </button>
        <div className="w-px h-4 bg-border/60 mx-0.5" />
        <DiffOptionsPopover />
      </div>
    </div>
  );
};
