import React from 'react';
import { Tooltip } from './Tooltip';

/**
 * The viewed circle the review app and the Inbox's PR rail share. It lives here so the Inbox window can draw a file
 * row without loading anything of review-editor's, whose reader is a chunk of its own. review-editor's `FileRowBits`
 * re-exports it.
 */

/** Viewed checkbox — always visible: green check-circle when viewed, empty
 * circle otherwise. Fixed 16px slot, same as StageControl, so the two align
 * as a column. (`forceVisible` retained as a no-op for call-site stability.) */
export const ViewedControl: React.FC<{
  isViewed: boolean;
  onToggle?: () => void;
  /** The file, for a screen reader's name; a host's rows pass it. */
  name?: string;
  /** Deprecated no-op — the control is always visible now. */
  forceVisible?: boolean;
}> = ({ isViewed, onToggle, name }) => (
  <Tooltip content={isViewed ? 'Viewed — click to unmark' : 'Mark as viewed'} side="bottom">
    <span
      role="checkbox"
      aria-checked={isViewed}
      aria-label={name ? (isViewed ? `${name}: viewed, unmark` : `Mark ${name} as viewed`) : isViewed ? 'Viewed — unmark' : 'Mark as viewed'}
      // tabIndex + key handling: these controls live INSIDE the row <button>
      // (a real nested <button> is invalid HTML), so they need their own
      // focus stop and Enter/Space activation to be keyboard-operable.
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onToggle?.();
        }
      }}
      className="w-4 h-4 flex items-center justify-center flex-shrink-0 rounded hover:bg-muted/50 cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/60"
    >
      {isViewed ? (
        <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5 text-muted-foreground opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      )}
    </span>
  </Tooltip>
);
