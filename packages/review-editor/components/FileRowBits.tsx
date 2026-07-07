import React from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import type { DiffFile } from '../types';

/**
 * Shared atoms for file rows — used by both the tree view (FileTreeNode) and
 * the sections view (SectionsPanel), so the two lists render one visual
 * language: same viewed circle, same leading change-type letter, same
 * stage button/dot.
 */

/** Viewed checkbox — always visible: green check-circle when viewed, empty
 * circle otherwise. Fixed 16px slot, same as StageControl, so the two align
 * as a column. (`forceVisible` retained as a no-op for call-site stability.) */
export const ViewedControl: React.FC<{
  isViewed: boolean;
  onToggle?: () => void;
  /** Deprecated no-op — the control is always visible now. */
  forceVisible?: boolean;
}> = ({ isViewed, onToggle }) => (
  <Tooltip content={isViewed ? 'Viewed — click to unmark' : 'Mark as viewed'} side="bottom" delayDuration={300}>
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

/** Right-anchored +/- pair — one fixed-width block so the numbers always end
 * flush at the row edge, stay tight together, and add-only rows leave no
 * phantom gap. */
export const DiffCounts: React.FC<{ additions: number; deletions: number }> = ({ additions, deletions }) => (
  <span className="min-w-[7ch] text-right whitespace-nowrap flex-shrink-0 text-[10px] tabular-nums">
    {additions > 0 && <span className="additions">+{additions}</span>}
    {additions > 0 && deletions > 0 && <span> </span>}
    {deletions > 0 && <span className="deletions">-{deletions}</span>}
  </span>
);

/** Leading change-type letter — A/D/R/U carry weight and color; modified gets
 * a whisper-quiet M so the column has no holes. Fixed slot keeps names aligned. */
export const ChangeTypeLetter: React.FC<{
  status: DiffFile['status'];
  oldPath?: string;
  untracked?: boolean;
}> = ({ status, oldPath, untracked }) => (
  <span className="w-3 text-center text-[10px] flex-shrink-0">
    {untracked ? (
      <span className="font-semibold text-muted-foreground/70" title="Untracked file">U</span>
    ) : status === 'added' ? (
      <span className="font-semibold text-success" title="Added file">A</span>
    ) : status === 'deleted' ? (
      <span className="font-semibold text-destructive" title="Deleted file">D</span>
    ) : status === 'renamed' ? (
      <span className="font-semibold text-[#007aff]" title={oldPath ? `Renamed from ${oldPath}` : 'Renamed file'}>R</span>
    ) : (
      <span className="text-muted-foreground/40" title="Modified file">M</span>
    )}
  </span>
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
      title="Stage file (git add)"
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
