import type { DiffOption } from '@plannotator/shared/types';

/** The diff a Commits-view exit should switch the session back to. */
export interface CommitViewRestoreTarget {
  /** FULL diff type, worktree prefix included when one applies. */
  diffType: string;
  /** Base to send with the switch; null means "let the server keep its own". */
  base: string | null;
}

// Same sha rule App.tsx's worktree parse and the server's parseCommitDiffType
// enforce: the commit family is exactly `commit:<bare-hex>` — either the whole
// diff type or the tail of a `worktree:<path>:commit:<sha>` composition (the
// path may itself contain colons, so only the anchored tail is trusted).
const COMMIT_FAMILY_RE = /(?:^|:)commit:[0-9a-f]{4,64}$/i;

/** True for the commit-family diff types (`commit:<sha>`, plain or
 * worktree-composed). Takes the FULL diff type, unlike commitShaFromMode
 * which reads the already-parsed base mode. */
export function isCommitDiffType(fullDiffType: string): boolean {
  return COMMIT_FAMILY_RE.test(fullDiffType);
}

/**
 * Resolve the diff to switch to when the panel view leaves Commits while a
 * commit diff is active. The memo — captured when the session first entered
 * the commit family — wins verbatim (full diff type + base, so the restore
 * lands exactly where the reviewer was). Without one (the page reloaded while
 * a commit diff was active; refs don't survive), fall back to the session
 * default with the SAME resolution handleWorktreeSwitch applies when it
 * abandons a commit diff: the configured default when the session offers it,
 * else the first offered option, else uncommitted — composed against the
 * active worktree so a worktree session stays in its worktree.
 */
export function resolveCommitExitDiff(
  memo: CommitViewRestoreTarget | null,
  fallback: {
    preferredDefault: string | null | undefined;
    diffOptions: ReadonlyArray<Pick<DiffOption, 'id'>>;
    activeWorktreePath: string | null;
  },
): CommitViewRestoreTarget {
  if (memo) return memo;
  const { preferredDefault, diffOptions, activeWorktreePath } = fallback;
  const resolved = diffOptions.some((o) => o.id === preferredDefault)
    ? (preferredDefault as string)
    : (diffOptions[0]?.id ?? 'uncommitted');
  return {
    diffType: activeWorktreePath ? `worktree:${activeWorktreePath}:${resolved}` : resolved,
    base: null,
  };
}
