import { describe, expect, test } from 'bun:test';
import { parsePatchFiles } from '@pierre/diffs';
import { newLineOf } from './newLineOf';

const fileOf = (hunks: string[]) =>
  parsePatchFiles(`diff --git a/a.txt b/a.txt\nindex 1111111..2222222 100644\n--- a/a.txt\n+++ b/a.txt\n${hunks.join('\n')}\n`)[0]!.files[0]!;

describe('newLineOf: an old line outside every hunk, on the new side', () => {
  // `git diff -U0` of 30 lines: two added at the top, three after line 5, 12-14 removed, 21 replaced, 30 removed.
  const zeroContext = fileOf([
    '@@ -0,0 +1,2 @@\n+top-a\n+top-b',
    '@@ -5,0 +8,3 @@ line 5\n+in-a\n+in-b\n+in-c',
    '@@ -12,3 +16,0 @@ line 11\n-line 12\n-line 13\n-line 14',
    '@@ -21 +23 @@ line 20\n-line 21\n+sw',
    '@@ -30 +31,0 @@ line 29\n-line 30',
  ]);

  test.each([
    [1, 3],
    [5, 7],
    [6, 11],
    [11, 16],
    [15, 17],
    [20, 22],
    [22, 24],
    [29, 31],
  ])('with no context around the hunks, old line %i is new line %i', (oldLine, newLine) => {
    expect(newLineOf(zeroContext, oldLine, 'old')).toBe(newLine);
  });

  test('a removal at the very top moves what follows up', () => {
    expect(newLineOf(fileOf(['@@ -1,3 +0,0 @@\n-a\n-b\n-c']), 4, 'old')).toBe(1);
  });

  test('hunks with context', () => {
    const file = fileOf(['@@ -3,3 +3,5 @@\n a\n+b\n+c\n d\n e', '@@ -20,3 +22,2 @@\n x\n-y\n z']);
    expect(newLineOf(file, 2, 'old')).toBe(2);
    expect(newLineOf(file, 10, 'old')).toBe(12);
    expect(newLineOf(file, 30, 'old')).toBe(31);
  });

  test('a new line is already its own number', () => {
    expect(newLineOf(zeroContext, 6, 'new')).toBe(6);
  });
});
