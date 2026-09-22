import { describe, expect, test } from 'bun:test';
import { parseDiffToFiles } from './diffParser';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { captureAnchorText, markOutdatedCodeAnnotations, readPatchLines } from './codeAnnotationAnchor';

const BEFORE_PUSH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,5 @@ function f() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' return a + b;',
  ' }',
  'diff --git a/src/gone.ts b/src/gone.ts',
  '--- a/src/gone.ts',
  '+++ b/src/gone.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  '',
].join('\n');

// A teammate pushed: a.ts line 12 changed text, lines 10-11 unchanged, and
// gone.ts left the diff entirely.
const AFTER_PUSH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,5 @@ function f() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 5;',
  ' return a + b;',
  ' }',
  '',
].join('\n');

function line(partial: Partial<CodeAnnotation>): CodeAnnotation {
  return {
    id: partial.id ?? 'x',
    type: 'comment',
    scope: 'line',
    filePath: 'src/a.ts',
    lineStart: 10,
    lineEnd: 10,
    side: 'new',
    text: 'note',
    createdAt: 1,
    ...partial,
  };
}

describe('readPatchLines', () => {
  const [a] = parseDiffToFiles(BEFORE_PUSH);

  test('reads each side at its own line numbers', () => {
    expect(readPatchLines(a.patch, 'new', 10, 12)).toBe('const a = 1;\nconst b = 3;\nconst c = 4;');
    expect(readPatchLines(a.patch, 'old', 11, 12)).toBe('const b = 2;\nreturn a + b;');
  });

  test('a range that leaves the hunk (context-expansion lines) reads as unknown, not partial', () => {
    expect(readPatchLines(a.patch, 'new', 13, 20)).toBeNull();
    expect(readPatchLines(a.patch, 'new', 1, 1)).toBeNull();
  });
});

describe('restoring a PR draft against a changed patch', () => {
  const before = parseDiffToFiles(BEFORE_PUSH);
  const after = parseDiffToFiles(AFTER_PUSH);

  function created(partial: Partial<CodeAnnotation>): CodeAnnotation {
    const ann = line(partial);
    const anchorText = captureAnchorText(ann, before);
    return anchorText === undefined ? ann : { ...ann, anchorText };
  }

  test('keeps comments whose lines still read the same, marks changed/removed ones outdated, drops none', () => {
    const unchanged = created({ id: 'same', lineStart: 10, lineEnd: 11 });
    const changed = created({ id: 'changed', lineStart: 12, lineEnd: 12 });
    const removedFile = created({ id: 'gone', filePath: 'src/gone.ts', lineStart: 1, lineEnd: 1 });
    const legacy = line({ id: 'legacy', lineStart: 10, lineEnd: 10 }); // no anchorText (old draft)

    const restored = markOutdatedCodeAnnotations([unchanged, changed, removedFile, legacy], after);

    expect(restored.map((a) => a.id)).toEqual(['same', 'changed', 'gone', 'legacy']);
    expect(restored[0]).toBe(unchanged); // untouched, same line numbers
    expect(restored.slice(1).map((a) => a.outdated)).toEqual([true, true, true]);
    // Never moved to a guessed line.
    expect(restored.map((a) => [a.lineStart, a.lineEnd])).toEqual([[10, 11], [12, 12], [1, 1], [10, 10]]);
  });

  test('file- and review-scoped comments carry over unchanged even when their file left the diff', () => {
    const fileComment = line({ id: 'f', scope: 'file', filePath: 'src/gone.ts' });
    const general = line({ id: 'g', scope: 'general', filePath: '', lineStart: 0, lineEnd: 0 });
    const restored = markOutdatedCodeAnnotations([fileComment, general], after);
    expect(restored[0]).toBe(fileComment);
    expect(restored[1]).toBe(general);
  });

  test('comments bound to another PR in the same draft are not judged against this diff', () => {
    const otherPr = line({ id: 'other', prUrl: 'https://github.com/o/r/pull/2', filePath: 'src/elsewhere.ts' });
    const restored = markOutdatedCodeAnnotations([otherPr], after, (a) => a.prUrl === undefined);
    expect(restored[0]).toBe(otherPr);
  });
});
