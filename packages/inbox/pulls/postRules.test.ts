import { describe, expect, test } from 'bun:test';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { onPullDiff } from './postRules';

const patchOf = (lines: string[]) => [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  `@@ -1,${lines.filter((l) => !l.startsWith('+')).length} +1,${lines.filter((l) => !l.startsWith('-')).length} @@`,
  ...lines,
  '',
].join('\n');
const GUIDE = parseDiffToFiles(patchOf([' one', '+two', ' three']));
const comment = (over: Partial<CodeAnnotation> = {}): CodeAnnotation => ({ id: 'c', type: 'comment', filePath: 'a.ts', lineStart: 2, lineEnd: 2, side: 'new', scope: 'line', text: 'Why two?', createdAt: 1, author: 'p', ...over }) as CodeAnnotation;

describe("a guided review's comment goes inline only if its lines are the PR's", () => {
  test('the same lines on the PR\'s diff: inline', () => {
    expect(onPullDiff([comment()], GUIDE, GUIDE)[0]!.onPullDiff).toBe(true);
  });
  test('another line there, or a neighbour that differs: the body', () => {
    expect(onPullDiff([comment()], GUIDE, parseDiffToFiles(patchOf([' one', '+2', ' three'])))[0]!.onPullDiff).toBeUndefined();
    expect(onPullDiff([comment()], GUIDE, parseDiffToFiles(patchOf([' one', '+two', ' 3'])))[0]!.onPullDiff).toBeUndefined();
  });
  test('a file the PR doesn\'t change, or a comment not on a line: the body', () => {
    expect(onPullDiff([comment()], GUIDE, [])[0]!.onPullDiff).toBeUndefined();
    expect(onPullDiff([comment({ scope: 'file' })], GUIDE, GUIDE)[0]!.onPullDiff).toBeUndefined();
  });
  test('a deleted line is read on the old side: inline when the PR deletes the same line, else the body', () => {
    const guide = parseDiffToFiles(patchOf([' one', '-gone', '+two', ' three']));
    const onDeleted = comment({ side: 'old', lineStart: 2, lineEnd: 2 });
    expect(onPullDiff([onDeleted], guide, guide)[0]!.onPullDiff).toBe(true);
    expect(onPullDiff([onDeleted], guide, parseDiffToFiles(patchOf([' one', '-went', '+two', ' three'])))[0]!.onPullDiff).toBeUndefined();
  });
  test('a range of lines: inline only when every line in it reads the same, not just its first', () => {
    const guide = parseDiffToFiles(patchOf([' a', ' b', '+c', ' d', ' e']));
    const range = comment({ lineStart: 1, lineEnd: 5 });
    expect(onPullDiff([range], guide, guide)[0]!.onPullDiff).toBe(true);
    // Line 5 is past the first line's context: only reading the whole range sees it differ.
    expect(onPullDiff([range], guide, parseDiffToFiles(patchOf([' a', ' b', '+c', ' d', ' E'])))[0]!.onPullDiff).toBeUndefined();
  });
});
