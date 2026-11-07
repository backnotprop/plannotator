import React from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';

/**
 * Shared atoms for file rows — used by both the tree view (FileTreeNode) and
 * the sections view (SectionsPanel), so the two lists render one visual
 * language: same viewed circle, same leading change-type letter, same
 * stage button/dot.
 *
 * The change-type letter is the shared diff-file-tree atom from
 * @plannotator/ui, re-exported so review call sites import one module. The
 * +/- numbers are the review's own `CountColumns` (two aligned columns), not
 * ui's `DiffCounts`.
 */
export { ChangeTypeLetter } from '@plannotator/ui/components/DiffFileTree';

/** Viewed checkbox — always visible: green check-circle when viewed, empty
 * circle otherwise. Fixed 16px slot, same as StageControl, so the two align
 * as a column. (`forceVisible` retained as a no-op for call-site stability.) */
export const ViewedControl: React.FC<{
  isViewed: boolean;
  onToggle?: () => void;
  /** Deprecated no-op — the control is always visible now. */
  forceVisible?: boolean;
}> = ({ isViewed, onToggle }) => (
  <Tooltip content={isViewed ? 'Viewed — click to unmark' : 'Mark as viewed'} side="bottom">
    <span
      role="checkbox"
      aria-checked={isViewed}
      aria-label={isViewed ? 'Viewed — unmark' : 'Mark as viewed'}
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

/** Staging affordance — plus button on unstaged working files (always
 * visible, brightens on hover), primary dot when staged, spinner mid-flight.
 * Fixed 16px slot. */
export const StageControl: React.FC<{
  isStaged: boolean;
  isStaging: boolean;
  onStage?: () => void;
}> = ({ isStaged, isStaging, onStage }) => {
  if (isStaged) {
    return (
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0" title="Staged (git add)" aria-label="Staged">
        <span className="w-1.5 h-1.5 rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <Tooltip content="Stage file (git add)" side="bottom">
      <span
        role="button"
        // tabIndex + key handling: lives INSIDE the row <button> (a real nested
        // <button> is invalid HTML), so it needs its own focus stop and
        // Enter/Space activation to be keyboard-operable.
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          if (!isStaging) onStage?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            if (!isStaging) onStage?.();
          }
        }}
        className="stage-plus w-4 h-4 flex-shrink-0 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-muted-foreground/60 hover:bg-muted/50 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/60"
        aria-label="Stage file"
      >
        {isStaging ? (
          <span className="inline-block w-2 h-2 border border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        )}
      </span>
    </Tooltip>
  );
};

/** Committed-file marker — green dot in the stage-slot column (committed rows
 * can't be staged, so the slot is otherwise empty). Mirrors StageControl's
 * primary staged dot: green = already committed, primary = staged. */
export const CommittedDot: React.FC = () => (
  <span className="w-4 h-4 flex items-center justify-center flex-shrink-0" title="Committed" aria-label="Committed">
    <span className="w-1.5 h-1.5 rounded-full bg-success" />
  </span>
);

/** File path that always keeps the filename visible. The directory part
 * absorbs all truncation (ellipsis lands right before the final slash);
 * only a filename that alone exceeds the row truncates at its own end. */
export const TruncatedPath: React.FC<{ path: string }> = ({ path }) => {
  const slash = path.lastIndexOf('/');
  if (slash === -1) return <span className="truncate">{path}</span>;
  return (
    <span className="flex items-center min-w-0">
      <span className="truncate">{path.slice(0, slash)}</span>
      <span className="flex-shrink-0 max-w-full truncate">{path.slice(slash)}</span>
    </span>
  );
};

/** Comment icon + annotation count, rendered directly after the file path. */
export const AnnotationBadge: React.FC<{ count: number }> = ({ count }) => {
  if (count <= 0) return null;
  return (
    <span className="flex items-center gap-0.5 text-[10px] text-primary flex-shrink-0" title={`${count} annotation${count === 1 ? '' : 's'}`}>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
      </svg>
      {count}
    </span>
  );
};

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

/** Below this panel width, group headings, folders and files drop their
 *  number columns (and a heading its viewed count), so names keep the room;
 *  All changes keeps its totals. Styles: `[data-compact-rows]` in index.css. */
export const COMPACT_ROWS_WIDTH = 220;
export const compactRowsProps = (width: number): { 'data-compact-rows'?: '' } =>
  width < COMPACT_ROWS_WIDTH ? { 'data-compact-rows': '' } : {};

/**
 * A foldable group heading in the left panel lists: the tree's kind blocks
 * (Code / Tests / Generated) and the Git status view's Committed / Changes /
 * Untracked (approved design record "review-sidebar-aligned").
 *
 * Flush: the kind icon sits where a folder's chevron sits (the panel's 16 px
 * content edge) and the label on the folder-name edge (34 px); with no icon
 * the label starts on the content edge. Heavier and darker than folders. The
 * whole 28 px row is the button, so Enter and Space fold it with no new keys.
 * The chevron follows the label: always shown on a folded group; on an open
 * one only on hover or keyboard focus (and always on touch screens), so a
 * folded group looks folded without a hover. Then whatever the caller adds
 * (the numbers). Styles: `.panel-section-heading` in index.css.
 */
export const PanelSectionHeader: React.FC<{
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  /** The heading's spoken name, when it should say more than the label
   *  (what the group holds, its numbers in words). */
  ariaLabel?: string;
  /** What the group holds, shown on hover and keyboard focus. */
  tooltip?: string;
}> = ({ label, collapsed, onToggle, icon, children, ariaLabel, tooltip }) => {
  const button = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={ariaLabel}
      data-panel-section-header=""
      data-collapsed={collapsed ? '' : undefined}
      className="panel-section-heading"
    >
      {icon ? (
        <span className="panel-heading-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="panel-heading-label">{label}</span>
      <svg className="panel-heading-chevron" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
      </svg>
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip content={tooltip} side="right" wide>
      {button}
    </Tooltip>
  ) : (
    button
  );
};
