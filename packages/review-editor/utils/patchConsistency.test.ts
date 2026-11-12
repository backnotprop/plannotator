import { describe, expect, test } from 'bun:test';
import { isContentConsistentWithPatch } from './patchConsistency';

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n') + '\n';

const NET_PLUS_3_PATCH = [
  'diff --git a/foo.ts b/foo.ts',
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -4,4 +4,7 @@',
  ' line4',
  '-line5',
  '-line6',
  '+new5',
  '+new6',
  '+new7',
  '+new8',
  '+new9',
  ' line7',
  '',
].join('\n');

describe('isContentConsistentWithPatch', () => {
  test('accepts contents whose totals match the patch net', () => {
    expect(isContentConsistentWithPatch(NET_PLUS_3_PATCH, lines(10), lines(13))).toBe(true);
  });

  test('rejects stale contents (file changed since the diff was captured)', () => {
    expect(isContentConsistentWithPatch(NET_PLUS_3_PATCH, lines(10), lines(16))).toBe(false);
    expect(isContentConsistentWithPatch(NET_PLUS_3_PATCH, lines(8), lines(13))).toBe(false);
  });

  test('passes one-sided contents through (added / deleted files)', () => {
    expect(isContentConsistentWithPatch(NET_PLUS_3_PATCH, null, lines(999))).toBe(true);
    expect(isContentConsistentWithPatch(NET_PLUS_3_PATCH, lines(999), null)).toBe(true);
  });

  test('passes hunkless patches through', () => {
    expect(isContentConsistentWithPatch('Binary files a/x and b/x differ\n', lines(1), lines(2))).toBe(true);
  });

  test('handles omitted hunk counts (single-line hunks)', () => {
    const patch = '--- a/f\n+++ b/f\n@@ -3 +3 @@\n-old\n+new\n';
    expect(isContentConsistentWithPatch(patch, lines(5), lines(5))).toBe(true);
    expect(isContentConsistentWithPatch(patch, lines(5), lines(7))).toBe(false);
  });

  test('is insensitive to trailing-newline differences', () => {
    const tenNoTrailing = lines(10).slice(0, -1);
    expect(isContentConsistentWithPatch(NET_PLUS_3_PATCH, tenNoTrailing, lines(13))).toBe(true);
  });
});
