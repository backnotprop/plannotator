/**
 * Back / forward and the jump-target line (approved design record
 * "review-explorer", step 3). Regressions guarded: Forward surviving a new
 * jump, Back and Forward losing the place they left, a repeated jump from the
 * same place filling Back with copies, and a definition opened at the wrong
 * line when the tab shows another revision than the working tree.
 */
import { describe, expect, test } from 'bun:test';
import {
  EMPTY_NAV_HISTORY,
  findSymbolLine,
  navigateBack,
  navigateForward,
  pushNavJump,
  pushRecentPath,
} from './explorerNavigation';

describe('back and forward', () => {
  test('a jump records where it started; back and forward swap places', () => {
    let history = pushNavJump(EMPTY_NAV_HISTORY, { path: 'a.ts', line: 11 });
    history = pushNavJump(history, { path: 'b.ts', line: 3 });
    const back = navigateBack(history, { path: 'c.ts', line: 40 })!;
    expect(back.target).toEqual({ path: 'b.ts', line: 3 });
    const forward = navigateForward(back.history, { path: 'b.ts', line: 3 })!;
    expect(forward.target).toEqual({ path: 'c.ts', line: 40 });
    expect(forward.history.back.map((l) => l.path)).toEqual(['a.ts', 'b.ts']);
  });

  test('a new jump drops Forward; the same start twice is one entry; empty answers null', () => {
    const back = navigateBack(pushNavJump(EMPTY_NAV_HISTORY, { path: 'a.ts' }), { path: 'b.ts' })!;
    expect(back.history.forward).toHaveLength(1);
    expect(pushNavJump(back.history, { path: null }).forward).toEqual([]);
    const twice = pushNavJump(pushNavJump(EMPTY_NAV_HISTORY, { path: 'a.ts', line: 2 }), { path: 'a.ts', line: 2 });
    expect(twice.back).toHaveLength(1);
    expect(navigateBack(EMPTY_NAV_HISTORY, { path: 'x' })).toBeNull();
    expect(navigateForward(EMPTY_NAV_HISTORY, { path: 'x' })).toBeNull();
  });

  test('recent paths: newest first, each once', () => {
    expect(pushRecentPath(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecentPath(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
  });
});

describe('findSymbolLine', () => {
  const content = ['import x', '', 'function other() {}', 'export function build() {', '  rebuild();', '}'].join('\n');
  test('the line itself, else the nearest whole-word match, else null', () => {
    expect(findSymbolLine(content, 'build', 4)).toBe(4);
    expect(findSymbolLine(content, 'build', 6)).toBe(4);
    // `rebuild` is not `build`.
    expect(findSymbolLine(content, 'build', 5)).toBe(4);
    expect(findSymbolLine(content, 'missing', 4)).toBeNull();
    expect(findSymbolLine(content, 'build', 400, 10)).toBeNull();
    expect(findSymbolLine(content, undefined, 3)).toBe(3);
  });
});
