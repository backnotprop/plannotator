import { describe, expect, test } from 'bun:test';
import { isCommitDiffType, resolveCommitExitDiff } from './commitViewRestore';

// isCommitDiffType must agree with App.tsx's worktree parse and the server's
// parseCommitDiffType about what the commit family IS — a divergence would
// capture/clear the leave-Commits restore memo on the wrong transitions.
describe('isCommitDiffType', () => {
  test('matches plain and worktree-composed commit diffs', () => {
    expect(isCommitDiffType('commit:36b855f57eb53531c1baa734586e2fb9981f9881')).toBe(true);
    expect(isCommitDiffType('commit:abcd')).toBe(true); // 4-char minimum, same as the parse
    expect(isCommitDiffType('worktree:/tmp/wt:commit:abcdef12')).toBe(true);
    // Worktree paths may contain colons; only the anchored tail decides.
    expect(isCommitDiffType('worktree:C:/work/tree:commit:abcdef12')).toBe(true);
  });

  test('rejects every non-commit diff type', () => {
    for (const t of [
      'since-base',
      'uncommitted',
      'last-commit',
      'worktree:/tmp/wt:since-base',
      'worktree:/tmp/wt:uncommitted',
      'gitbutler:workspace',
      'commit:', // no sha
      'commit:xyz!', // non-hex
      'commit:abc', // below the 4-char minimum the parse enforces
      'my-commit-mode', // contains the word, not the family
    ]) {
      expect(isCommitDiffType(t)).toBe(false);
    }
  });
});

describe('resolveCommitExitDiff', () => {
  const fallback = {
    preferredDefault: 'since-base',
    diffOptions: [{ id: 'since-base' }, { id: 'uncommitted' }],
    activeWorktreePath: null,
  };

  test('memo wins verbatim, base included', () => {
    const memo = { diffType: 'worktree:/tmp/wt:merge-base', base: 'origin/main' };
    expect(resolveCommitExitDiff(memo, fallback)).toEqual(memo);
  });

  test('no memo: preferred default used only when the session offers it', () => {
    expect(resolveCommitExitDiff(null, fallback)).toEqual({ diffType: 'since-base', base: null });
    // Offered but not first: must win over diffOptions[0].
    expect(
      resolveCommitExitDiff(null, { ...fallback, preferredDefault: 'uncommitted' }),
    ).toEqual({ diffType: 'uncommitted', base: null });
    expect(
      resolveCommitExitDiff(null, { ...fallback, preferredDefault: 'merge-base' }),
    ).toEqual({ diffType: 'since-base', base: null }); // first offered option
  });

  test('no memo, no options: uncommitted', () => {
    expect(
      resolveCommitExitDiff(null, { preferredDefault: undefined, diffOptions: [], activeWorktreePath: null }),
    ).toEqual({ diffType: 'uncommitted', base: null });
  });

  test('no memo in a worktree session: fallback composes the worktree prefix', () => {
    expect(
      resolveCommitExitDiff(null, { ...fallback, activeWorktreePath: '/tmp/wt' }),
    ).toEqual({ diffType: 'worktree:/tmp/wt:since-base', base: null });
  });
});
