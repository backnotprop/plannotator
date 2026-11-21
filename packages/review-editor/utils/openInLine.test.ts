import { describe, expect, test } from 'bun:test';
import { openInLineForDiff } from './openInLine';

const patch = [
  'diff --git a/src/retry.ts b/src/retry.ts',
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -10,6 +10,7 @@ export function retry() {',
  '   const a = 1;',
  '   const b = 2;',
  '-  const c = 3;',
  '+  const c = 4;',
  '+  const d = 5;',
  '   return a;',
  ' }',
  '@@ -40,3 +41,2 @@',
  '   x();',
  '-  y();',
  '   z();',
].join('\n');

describe('openInLineForDiff', () => {
  test('nothing picked: the file opens at its first change', () => {
    expect(openInLineForDiff(patch)).toBe(12);
  });

  test('new-side lines picked: their first line', () => {
    expect(openInLineForDiff(patch, { start: 13, side: 'additions' })).toBe(13);
  });

  test('removed lines picked: where they were in the new file', () => {
    expect(openInLineForDiff(patch, { start: 12, side: 'deletions' })).toBe(12);
    expect(openInLineForDiff(patch, { start: 41, side: 'deletions' })).toBe(42);
  });

  test('a new file opens at line 1; a patch with no hunk sends no line', () => {
    expect(openInLineForDiff('--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two')).toBe(1);
    expect(openInLineForDiff('Binary files differ')).toBeUndefined();
  });
});
