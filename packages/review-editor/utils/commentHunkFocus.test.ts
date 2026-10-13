import { describe, expect, test } from 'bun:test';
import { bitbucketDiffHunk } from '../../shared/pr-bitbucket';
import { focusCommentHunk } from './commentHunkFocus';

// Same shape as tests/test-fixtures/bitbucket/diff.txt (Bitbucket /diff output):
// a 40-line new file and a modified file whose hunk removes and adds lines.
const fileLines = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`);
const PATCH = [
  'diff --git a/src/long.ts b/src/long.ts',
  'new file mode 100644',
  'index 0000000..b370dea',
  '--- /dev/null',
  '+++ b/src/long.ts',
  '@@ -0,0 +1,40 @@',
  ...fileLines.map((l) => `+${l}`),
  'diff --git a/src/mod.ts b/src/mod.ts',
  'index 8eb502a..a3847fa 100644',
  '--- a/src/mod.ts',
  '+++ b/src/mod.ts',
  '@@ -20,10 +20,10 @@ export function f() {',
  ' a20',
  ' a21',
  ' a22',
  ' a23',
  '-old24',
  '-old25',
  '+new24',
  '+new25',
  ' a26',
  ' a27',
  ' a28',
  ' a29',
  '',
].join('\n');

const cutNew = (line: number) => bitbucketDiffHunk(PATCH, 'src/long.ts', 'RIGHT', line)!;

describe('focusCommentHunk', () => {
  test('new-side comment on line 28 of a new file shows lines 25-28, not 1-5', () => {
    const full = cutNew(28);
    expect(full.split('\n')[1]).toBe('+const line1 = 1;'); // the full hunk starts at line 1
    expect(focusCommentHunk(full, { side: 'RIGHT', line: 28 })).toBe(
      '@@ -0,0 +25,4 @@\n+const line25 = 25;\n+const line26 = 26;\n+const line27 = 27;\n+const line28 = 28;',
    );
  });

  test('multi-line range shows exactly the range', () => {
    const focused = focusCommentHunk(cutNew(30), { side: 'RIGHT', line: 30, startLine: 26 });
    expect(focused.split('\n')[0]).toBe('@@ -0,0 +26,5 @@');
    expect(focused.split('\n')[1]).toBe('+const line26 = 26;');
    expect(focused.split('\n').at(-1)).toBe('+const line30 = 30;');
  });

  test('old-side comment counts old line numbers and keeps the function context', () => {
    const full = bitbucketDiffHunk(PATCH, 'src/mod.ts', 'LEFT', 25)!;
    expect(focusCommentHunk(full, { side: 'LEFT', line: 25 })).toBe(
      '@@ -22,4 +22,2 @@ export function f() {\n a22\n a23\n-old24\n-old25',
    );
  });

  test('new-side comment after removed lines', () => {
    const full = bitbucketDiffHunk(PATCH, 'src/mod.ts', 'RIGHT', 27)!;
    expect(focusCommentHunk(full, { side: 'RIGHT', line: 27 })).toBe(
      '@@ -26,2 +24,4 @@ export function f() {\n+new24\n+new25\n a26\n a27',
    );
  });

  test('a short hunk is returned unchanged', () => {
    const hunk = '@@ -1 +0,0 @@\n-old notes';
    expect(focusCommentHunk(hunk, { side: 'LEFT', line: 1 })).toBe(hunk);
  });

  test('GitHub-shaped hunk with no line (outdated) keeps the tail', () => {
    const hunk = ['@@ -0,0 +1,10 @@', ...Array.from({ length: 10 }, (_, i) => `+l${i + 1}`)].join('\n');
    expect(focusCommentHunk(hunk, { side: null, line: null })).toBe('@@ -0,0 +7,4 @@\n+l7\n+l8\n+l9\n+l10');
  });

  test('unparseable or unmatched input is returned unchanged', () => {
    expect(focusCommentHunk('not a hunk', { side: 'RIGHT', line: 3 })).toBe('not a hunk');
    const hunk = cutNew(28);
    expect(focusCommentHunk(hunk, { side: 'RIGHT', line: 99 })).toBe(hunk);
  });
});

describe('focusCommentHunk edge shapes', () => {
  test('CRLF hunks are focused and keep their line endings', () => {
    const hunk = ['@@ -0,0 +1,8 @@', ...Array.from({ length: 8 }, (_, i) => `+l${i + 1}`)].join('\r\n');
    expect(focusCommentHunk(hunk, { side: 'RIGHT', line: 8 })).toBe(
      ['@@ -0,0 +5,4 @@', '+l5', '+l6', '+l7', '+l8'].join('\r\n'),
    );
  });

  test('a string with more than one hunk is left whole (numbering would not restart)', () => {
    const hunk = '@@ -1,2 +1,2 @@\n a\n b\n@@ -3,2 +3,2 @@\n x\n+y\n z\n w';
    expect(focusCommentHunk(hunk, { side: 'RIGHT', line: 4 })).toBe(hunk);
  });
});
