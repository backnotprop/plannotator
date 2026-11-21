import { describe, expect, test } from 'bun:test';
import { filesToHide } from './useHiddenViewedFiles';

// #2713: with Hide viewed on, opening a file auto-marks the one you left as
// viewed. Hiding that row at once moved every row under it under the pointer.
describe('filesToHide', () => {
  test('pointer away from the list: every viewed file is hidden', () => {
    const viewed = new Set(['a.ts', 'b.ts']);
    expect([...filesToHide(viewed, null)].sort()).toEqual(['a.ts', 'b.ts']);
  });

  test('a file viewed while the pointer is in the list stays until the pointer leaves', () => {
    const atEnter = new Set(['a.ts']);
    const viewedNow = new Set(['a.ts', 'b.ts']);
    expect([...filesToHide(viewedNow, atEnter)]).toEqual(['a.ts']);
    expect([...filesToHide(viewedNow, null)].sort()).toEqual(['a.ts', 'b.ts']);
  });

  test('a file un-viewed while the pointer is in the list shows again at once', () => {
    const atEnter = new Set(['a.ts', 'b.ts']);
    expect([...filesToHide(new Set(['b.ts']), atEnter)]).toEqual(['b.ts']);
  });
});
