/**
 * Expand all stays on from commit to commit: commit diffs open folded, and once the person presses Expand all on
 * one, the next commit they step to opens expanded, until they press Collapse all on a commit again.
 *
 * What regresses if this fails: every step to the next commit folds every file again, or a press reseeds (and
 * remounts) the commit on screen.
 */
import { describe, expect, test } from 'bun:test';
import { commitFoldingFor, commitFoldingPressed } from './commitFolding';

describe('commit folding', () => {
  test('a commit opens folded; after Expand all the next commits open expanded; Collapse all folds them again', () => {
    let f = commitFoldingFor(null, 'aaa');
    expect(f.collapsed).toBe(true);
    f = commitFoldingPressed(f, false);
    // The commit on screen keeps its seed: no reseed for the press itself.
    expect(commitFoldingFor(f, 'aaa').collapsed).toBe(true);
    f = commitFoldingFor(f, 'bbb');
    expect(f.collapsed).toBe(false);
    f = commitFoldingFor(f, 'ccc');
    expect(f.collapsed).toBe(false);
    f = commitFoldingPressed(f, true);
    expect(commitFoldingFor(f, 'ccc').collapsed).toBe(false);
    expect(commitFoldingFor(f, 'ddd').collapsed).toBe(true);
  });

  test('the same commit keeps the same object; outside a commit nothing is folded and a press there is not remembered', () => {
    const f = commitFoldingFor(null, 'aaa');
    expect(commitFoldingFor(f, 'aaa')).toBe(f);
    const outside = commitFoldingFor(f, null);
    expect(outside.collapsed).toBe(false);
    expect(commitFoldingPressed(outside, false)).toBe(outside);
    expect(commitFoldingFor(commitFoldingPressed(outside, false), 'bbb').collapsed).toBe(true);
  });
});
