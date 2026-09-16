import { describe, expect, test } from 'bun:test';
import {
  getHunkTargetLine,
  resolveTargetHunkIndex,
} from './hunkNavigation';

describe('hunkNavigation: resolveTargetHunkIndex', () => {
  const HUNKS = [100, 350, 800, 1500];

  test('guards against staying on current hunk due to subpixel/scroll settling (next jump from hunk top)', () => {
    // When exactly at or slightly past hunk 0 (100 or 105), next must jump to hunk 1 (350), not re-target 0
    expect(resolveTargetHunkIndex(HUNKS, 100, 'next')).toBe(1);
    expect(resolveTargetHunkIndex(HUNKS, 105, 'next')).toBe(1);
    expect(resolveTargetHunkIndex(HUNKS, 95, 'next')).toBe(0);
    // Pin that epsilon is active (>=1px) while the 95->0 assertion pins it bounded (<5px)
    expect(resolveTargetHunkIndex(HUNKS, 99, 'next')).toBe(1);
  });

  test('guards against out-of-bounds index or looping past the last hunk (next jump)', () => {
    // When at or past the final hunk (1500), next must return null rather than wrap or exceed bounds
    expect(resolveTargetHunkIndex(HUNKS, 1500, 'next')).toBeNull();
    expect(resolveTargetHunkIndex(HUNKS, 1600, 'next')).toBeNull();
  });

  test('guards against jumping to the wrong target when positioned between hunks (next jump)', () => {
    // Positioned midway between hunk 1 (350) and hunk 2 (800)
    expect(resolveTargetHunkIndex(HUNKS, 500, 'next')).toBe(2);
  });

  test('guards against staying on current hunk due to subpixel rounding (prev jump from hunk top)', () => {
    // When at hunk 2 (800), prev must jump to hunk 1 (350), not re-target 2
    expect(resolveTargetHunkIndex(HUNKS, 800, 'prev')).toBe(1);
    // 805 is 5px inside hunk 2, so prev goes to hunk 2's top at index 2
    expect(resolveTargetHunkIndex(HUNKS, 805, 'prev')).toBe(2);
  });

  test('guards against negative index when at or before the first hunk (prev jump)', () => {
    // When at or above hunk 0 (100), prev must return null rather than negative index
    expect(resolveTargetHunkIndex(HUNKS, 100, 'prev')).toBeNull();
    expect(resolveTargetHunkIndex(HUNKS, 50, 'prev')).toBeNull();
    expect(resolveTargetHunkIndex(HUNKS, 0, 'prev')).toBeNull();
  });

  test('guards against wrong target when positioned between hunks (prev jump)', () => {
    // Positioned midway between hunk 1 (350) and hunk 2 (800)
    expect(resolveTargetHunkIndex(HUNKS, 600, 'prev')).toBe(1);
    // Positioned midway between hunk 0 (100) and hunk 1 (350)
    expect(resolveTargetHunkIndex(HUNKS, 250, 'prev')).toBe(0);
  });

  test('guards against crash or infinite loop when hunk list is empty', () => {
    expect(resolveTargetHunkIndex([], 0, 'next')).toBeNull();
    expect(resolveTargetHunkIndex([], 100, 'prev')).toBeNull();
  });
});

describe('hunkNavigation: getHunkTargetLine', () => {
  test('resolves additionStart for hunks with additions', () => {
    const hunk = {
      additionStart: 25,
      additionCount: 10,
      additionLines: 4,
      deletionStart: 20,
      deletionCount: 2,
    };
    expect(getHunkTargetLine(hunk)).toEqual({ lineNumber: 25, side: 'additions' });
  });

  test('resolves deletionStart for pure deletion hunks', () => {
    const pureDeletionHunk = {
      additionStart: 0,
      additionCount: 0,
      additionLines: 0,
      deletionStart: 45,
      deletionCount: 5,
      deletionLines: 5,
    };
    expect(getHunkTargetLine(pureDeletionHunk)).toEqual({ lineNumber: 45, side: 'deletions' });
  });

  test('falls back gracefully when starts are zero or missing', () => {
    expect(getHunkTargetLine({})).toEqual({ lineNumber: 1 });
  });
});
