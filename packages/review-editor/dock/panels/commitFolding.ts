import { useCallback, useRef } from 'react';

/**
 * How a commit diff's files open. A commit opens folded, unless the person's
 * last Collapse all / Expand all press on a commit diff was Expand all: that
 * stays on from commit to commit. Decided once per commit, so a press never
 * changes the seed of the commit on screen (which would remount its view).
 */
export interface CommitFolding {
  /** The commit the seed was decided for; null outside a commit diff. */
  sha: string | null;
  /** Seed the commit's files folded. */
  collapsed: boolean;
  /** The last press on a commit diff was Expand all. */
  keptExpanded: boolean;
}

/** The folding for the commit on screen: the same object while it is the same commit. */
export function commitFoldingFor(prev: CommitFolding | null, sha: string | null): CommitFolding {
  if (prev && prev.sha === sha) return prev;
  const keptExpanded = prev?.keptExpanded ?? false;
  return { sha, collapsed: sha !== null && !keptExpanded, keptExpanded };
}

/** A Collapse all / Expand all press: remembered only on a commit diff; the seed on screen stays. */
export function commitFoldingPressed(prev: CommitFolding, collapsed: boolean): CommitFolding {
  if (prev.sha === null) return prev;
  return { ...prev, keptExpanded: !collapsed };
}

/** `commitFoldingFor` kept across renders, for the all-files panel. */
export function useCommitFolding(sha: string | null): { defaultCollapsed: boolean; onCollapseAllPressed: (collapsed: boolean) => void } {
  const folding = useRef<CommitFolding | null>(null);
  folding.current = commitFoldingFor(folding.current, sha);
  const onCollapseAllPressed = useCallback((collapsed: boolean) => {
    if (folding.current) folding.current = commitFoldingPressed(folding.current, collapsed);
  }, []);
  return { defaultCollapsed: folding.current.collapsed, onCollapseAllPressed };
}
