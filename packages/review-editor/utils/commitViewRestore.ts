import type { DiffOption } from '@plannotator/shared/types';

export interface CommitViewRestoreTarget {
  diffType: string;
  base: string | null;
}

const COMMIT_FAMILY_RE = /(?:(?:^|:)commit:|^jj-commit:)[0-9a-f]{4,64}$/i;

export function isCommitDiffType(fullDiffType: string): boolean {
  return COMMIT_FAMILY_RE.test(fullDiffType);
}

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
