import React from 'react';
import { Tooltip } from './Tooltip';

/**
 * The viewed circle and the +/- columns the review app and the Inbox's PR rail share. They live here so the Inbox
 * window can draw a file row without loading anything of review-editor's, whose reader is a chunk of its own.
 * review-editor's `FileRowBits` re-exports them. The columns' styles are each host's (`.review-count-columns`).
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

/**
 * The +/- counts as two right-aligned columns: each + ends on one edge and
 * each - on the next, on every row of the panel (All changes, group headings,
 * folders, files), so the size of each change reads down one column. The
 * column widths come from `--count-add-w` / `--count-del-w`, which the panel
 * sets from its widest numbers (`countColumnVars`); a number wider than that
 * grows its own row instead of overlapping. `tone="quiet"` draws both numbers
 * in the panel's tertiary grey (headings, folders); file rows keep the green
 * and red of `.file-tree-item .additions / .deletions`.
 */
export const CountColumns: React.FC<{
  additions: number;
  deletions: number;
  tone?: 'color' | 'quiet';
  addStyle?: React.CSSProperties;
  delStyle?: React.CSSProperties;
}> = ({ additions, deletions, tone = 'color', addStyle, delStyle }) => (
  <span data-count-columns={tone} className="review-count-columns">
    <span className={additions > 0 ? 'additions' : undefined} style={addStyle}>
      {additions > 0 ? `+${additions}` : ''}
    </span>
    <span className={deletions > 0 ? 'deletions' : undefined} style={delStyle}>
      {deletions > 0 ? `-${deletions}` : ''}
    </span>
  </span>
);

/** The column widths for a panel whose largest numbers are `additions` and
 *  `deletions` (the whole change's totals: every row's count is part of
 *  them). At least 3 characters, so a panel of small changes keeps its edge;
 *  2 px over, because a sign is a little wider than a tabular digit. */
export function countColumnVars(additions: number, deletions: number): React.CSSProperties {
  const width = (n: number) => `calc(${Math.max(3, String(n).length + 1)}ch + 2px)`;
  return { '--count-add-w': width(additions), '--count-del-w': width(deletions) } as React.CSSProperties;
}
