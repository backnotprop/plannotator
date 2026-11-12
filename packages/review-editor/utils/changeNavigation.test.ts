import { describe, expect, test } from 'bun:test';
import { getSingularPatch } from '@pierre/diffs';
import { changeJumpDirection, listDiffChanges, readingLineFor, resolveChangeJump } from './changeNavigation';

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,9 +1,9 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  ' four',
  ' five',
  '+five-b',
  ' six',
  ' seven',
  '-eight',
  ' nine',
  '@@ -20,3 +20,2 @@',
  ' twenty',
  '-x',
  ' z',
  '',
].join('\n');

describe('listDiffChanges', () => {
  test('one entry per run of changed lines, not per hunk', () => {
    expect(listDiffChanges(getSingularPatch(PATCH).hunks)).toEqual([
      { unifiedIndex: 1, lineNumber: 2, side: 'deletions' },
      { unifiedIndex: 6, lineNumber: 6, side: 'additions' },
      { unifiedIndex: 9, lineNumber: 8, side: 'deletions' },
      { unifiedIndex: 22, lineNumber: 21, side: 'deletions' },
    ]);
  });

  test('a diff with no hunks (a rendered Markdown file) has no changes', () => {
    expect(listDiffChanges([])).toEqual([]);
    expect(listDiffChanges(undefined)).toEqual([]);
  });
});

describe('resolveChangeJump', () => {
  const placements = ['before', 'before', 'at', 'after', 'after'] as const;

  test('without a current change: the first ahead / the last behind the reading line', () => {
    expect(resolveChangeJump(placements, 'next', null)).toBe(3);
    expect(resolveChangeJump(placements, 'prev', null)).toBe(1);
  });

  test('from the change the last jump landed on, whatever the scroll could do', () => {
    expect(resolveChangeJump(['before', 'before', 'after'], 'prev', 2)).toBe(1);
    expect(resolveChangeJump(['before', 'before', 'after'], 'next', 2)).toBeNull();
    expect(resolveChangeJump(['after', 'after'], 'prev', 0)).toBeNull();
  });

  test('nothing to land on', () => {
    expect(resolveChangeJump([], 'next', null)).toBeNull();
    expect(resolveChangeJump(['before'], 'next', null)).toBeNull();
    expect(resolveChangeJump(['after'], 'prev', null)).toBeNull();
  });
});

describe('changeJumpDirection', () => {
  const key = (init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent => ({
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    composedPath: () => [],
    ...init,
  }) as unknown as KeyboardEvent;

  test('N is next, Shift+N previous (the bindings in shortcuts.ts)', () => {
    expect(changeJumpDirection(key({ key: 'n' }))).toBe('next');
    expect(changeJumpDirection(key({ key: 'N', shiftKey: true }))).toBe('prev');
    expect(changeJumpDirection(key({ key: 'N' }))).toBe('next');
  });

  test('not with Mod or Alt, not P, not mid-composition, not once taken', () => {
    expect(changeJumpDirection(key({ key: 'n', metaKey: true }))).toBeNull();
    expect(changeJumpDirection(key({ key: 'n', ctrlKey: true }))).toBeNull();
    expect(changeJumpDirection(key({ key: 'n', altKey: true }))).toBeNull();
    expect(changeJumpDirection(key({ key: 'p' }))).toBeNull();
    expect(changeJumpDirection(key({ key: 'P', shiftKey: true }))).toBeNull();
    expect(changeJumpDirection(key({ key: 'n', isComposing: true }))).toBeNull();
    expect(changeJumpDirection(key({ key: 'n', defaultPrevented: true }))).toBeNull();
  });

  test('not from a field the person types in, shadow DOM included', () => {
    const typing = (origin: object) => key({ key: 'n', composedPath: () => [origin as EventTarget] });
    expect(changeJumpDirection(typing({ tagName: 'TEXTAREA' }))).toBeNull();
    expect(changeJumpDirection(typing({ tagName: 'INPUT' }))).toBeNull();
    expect(changeJumpDirection(typing({ tagName: 'SELECT' }))).toBeNull();
    expect(changeJumpDirection(typing({ tagName: 'DIV', isContentEditable: true }))).toBeNull();
    expect(changeJumpDirection(typing({ tagName: 'DIV', isContentEditable: false }))).toBe('next');
  });
});

describe('readingLineFor', () => {
  const view = { top: 0, bottom: 800 };
  const middle = { atTop: false, atBottom: false };

  test('the middle of the view while scrolled somewhere in between', () => {
    expect(readingLineFor(view, 'next', middle)).toBe(400);
    expect(readingLineFor(view, 'prev', middle)).toBe(400);
  });

  test('N at the top and Shift+N at the bottom take changes already on screen', () => {
    expect(readingLineFor(view, 'next', { atTop: true, atBottom: false })).toBeLessThan(view.top);
    expect(readingLineFor(view, 'prev', { atTop: false, atBottom: true })).toBeGreaterThan(view.bottom);
    expect(readingLineFor(view, 'prev', { atTop: true, atBottom: false })).toBe(400);
    expect(readingLineFor(view, 'next', { atTop: false, atBottom: true })).toBe(400);
  });
});
