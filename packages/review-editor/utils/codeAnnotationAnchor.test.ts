import { describe, expect, test } from 'bun:test';
import { parseDiffToFiles } from './diffParser';
import type { CodeAnnotation } from '@plannotator/ui/types';
import {
  annotationNavigation,
  canPostInline,
  captureAnchor,
  markOutdatedCodeAnnotations,
  readPatchLines,
  reanchorCodeAnnotations,
  restorableViewedFiles,
} from './codeAnnotationAnchor';

function patch(file: string, header: string, body: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, header, ...body, ''].join('\n');
}

const BEFORE_PUSH = [
  patch('src/a.ts', '@@ -10,4 +10,5 @@ function f() {', [
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a + b;',
    ' }',
  ]),
  patch('src/gone.ts', '@@ -1,1 +1,1 @@', ['-old', '+new']),
].join('');

// A teammate pushed: a.ts line 12 changed text, lines 10-11 unchanged, and
// gone.ts left the diff entirely.
const AFTER_PUSH = patch('src/a.ts', '@@ -10,4 +10,5 @@ function f() {', [
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 5;',
  ' return a + b;',
  ' }',
]);

// Longer hunk for the keep case: only line 16 changes, so a comment on line
// 11 keeps both its text and its two-line surroundings.
const LONG_BEFORE = patch('src/long.ts', '@@ -10,7 +10,7 @@', [
  ' l10', ' l11', ' l12', ' l13', ' l14', ' l15', '-l16', '+l16 v1',
]);
const LONG_AFTER = patch('src/long.ts', '@@ -10,7 +10,7 @@', [
  ' l10', ' l11', ' l12', ' l13', ' l14', ' l15', '-l16', '+l16 v2',
]);

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
    return { ...ann, ...captureAnchor(ann, before), anchorSnapshot: 'snap-before' };
  }

  test('keeps comments whose lines and surroundings still read the same, marks changed/removed ones outdated, drops none', () => {
    const longBefore = parseDiffToFiles(LONG_BEFORE);
    const kept = line({ id: 'same', filePath: 'src/long.ts', lineStart: 11, lineEnd: 11 });
    const unchanged = { ...kept, ...captureAnchor(kept, longBefore), anchorSnapshot: 'snap-before' };
    const changed = created({ id: 'changed', lineStart: 12, lineEnd: 12 });
    const removedFile = created({ id: 'gone', filePath: 'src/gone.ts', lineStart: 1, lineEnd: 1 });
    const legacy = line({ id: 'legacy', lineStart: 10, lineEnd: 10 }); // no anchor fields (old draft)

    const restored = markOutdatedCodeAnnotations(
      [unchanged, changed, removedFile, legacy],
      [...after, ...parseDiffToFiles(LONG_AFTER)],
      undefined,
      'snap-after',
    );

    expect(restored.map((a) => a.id)).toEqual(['same', 'changed', 'gone', 'legacy']);
    expect(restored[0].outdated).toBeUndefined();
    expect(restored[0].anchorSnapshot).toBe('snap-after'); // re-stamped for the new diff
    expect(restored.slice(1).map((a) => a.outdated)).toEqual([true, true, true]);
    // Never moved to a guessed line.
    expect(restored.map((a) => [a.lineStart, a.lineEnd])).toEqual([[11, 11], [12, 12], [1, 1], [10, 10]]);
  });

  test('a common line whose own text survives but whose surroundings changed is outdated, not "still valid"', () => {
    // Line 14 is a lone `}` in both diffs; the line above it changed.
    const onBrace = { ...line({ id: 'brace', lineStart: 14, lineEnd: 14 }) };
    const stamped = { ...onBrace, ...captureAnchor(onBrace, parseDiffToFiles(patch('src/a.ts', '@@ -12,3 +12,3 @@', [
      ' const b = 3;',
      '-  return a;',
      '+  return b;',
      ' }',
    ]))), anchorSnapshot: 's1' };
    expect(stamped.anchorText).toBe('}');
    const pushed = parseDiffToFiles(patch('src/a.ts', '@@ -12,3 +12,3 @@', [
      ' const b = 3;',
      '-  return a;',
      '+  return null;',
      ' }',
    ]));
    const [result] = markOutdatedCodeAnnotations([stamped], pushed, undefined, 's2');
    expect(result.outdated).toBe(true);
  });

  test('an identical block that now sits in a different function (hunk header) is outdated', () => {
    const body = [' if (!x) {', '   return null;', ' }', '-a', '+b'];
    const onReturn = line({ id: 'ret', lineStart: 21, lineEnd: 21 });
    const original = parseDiffToFiles(patch('src/a.ts', '@@ -20,4 +20,4 @@ function load() {', body));
    const stamped = { ...onReturn, ...captureAnchor(onReturn, original), anchorSnapshot: 's1' };
    expect(stamped.anchorContext?.hunk).toBe('function load() {');
    // Same lines, same numbers — but the hunk is now inside save().
    const moved = parseDiffToFiles(patch('src/a.ts', '@@ -20,4 +20,4 @@ function save() {', body));
    expect(markOutdatedCodeAnnotations([stamped], moved, undefined, 's2')[0].outdated).toBe(true);
    // Same function: still valid.
    expect(markOutdatedCodeAnnotations([stamped], original, undefined, 's2')[0].outdated).toBeUndefined();
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

describe('in-session re-check when the diff on screen changes', () => {
  const before = parseDiffToFiles(BEFORE_PUSH);
  const after = parseDiffToFiles(AFTER_PUSH);

  test('only comments stamped with another snapshot are re-checked; unstamped and current ones are left alone', () => {
    const current = { ...line({ id: 'cur' }), anchorSnapshot: 'snap-after' };
    const unstamped = line({ id: 'old-draft', lineStart: 12, lineEnd: 12 });
    const stale = { ...line({ id: 'stale', lineStart: 12, lineEnd: 12 }), ...captureAnchor(line({ lineStart: 12, lineEnd: 12 }), before), anchorSnapshot: 'snap-before' };
    const input = [current, unstamped, stale];
    const out = reanchorCodeAnnotations(input, after, { currentSnapshot: 'snap-after' });
    expect(out[0]).toBe(current);
    expect(out[1]).toBe(unstamped);
    expect(out[2].outdated).toBe(true);
  });

  test('returns the same array when nothing needed checking (no spurious state writes)', () => {
    const input = [{ ...line({}), anchorSnapshot: 's' }];
    expect(reanchorCodeAnnotations(input, after, { currentSnapshot: 's' })).toBe(input);
  });
});

describe('what may be posted inline on a PR', () => {
  const A = 'https://github.com/acme/widgets/pull/1';
  const B = 'https://github.com/acme/widgets/pull/2';
  const known = new Map([[A, 'sA'], [B, 'sB']]);

  test('not when outdated, or when its PR is known to have moved to another snapshot', () => {
    expect(canPostInline({ ...line({ prUrl: A }), anchorSnapshot: 'sA' }, known, A)).toBe(true);
    expect(canPostInline({ ...line({ prUrl: B }), anchorSnapshot: 'sB' }, known, A)).toBe(true);
    // Anchored on a diff of B we no longer see (B was pushed since).
    expect(canPostInline({ ...line({ prUrl: B }), anchorSnapshot: 'old' }, known, A)).toBe(false);
    expect(canPostInline({ ...line({ prUrl: A }), anchorSnapshot: 'sA', outdated: true }, known, A)).toBe(false);
  });

  test('a PR whose snapshot this page has not seen is trusted (after a reload only the on-screen PR is known)', () => {
    // Regression (#1592): a valid comment on another PR was posted as Outdated
    // after a tab reload, though that PR never changed.
    expect(canPostInline({ ...line({ prUrl: 'https://github.com/acme/widgets/pull/9' }), anchorSnapshot: 'x' }, known, A)).toBe(true);
  });

  test('an unstamped (older) comment is trusted', () => {
    expect(canPostInline(line({ prUrl: A }), known, A)).toBe(true);
    expect(canPostInline(line({}), known, A)).toBe(true);
    expect(canPostInline(line({ prUrl: B }), known, A)).toBe(true);
  });
});

describe('sidebar navigation', () => {
  test('an outdated comment opens its file without a scroll request; others scroll', () => {
    expect(annotationNavigation(line({ outdated: true }))).toBe('select-file');
    expect(annotationNavigation(line({}))).toBe('scroll');
  });
});

describe('viewed marks restored from a draft', () => {
  const files = parseDiffToFiles(AFTER_PUSH);

  test('after a push, a file still in the diff is not re-marked Viewed', () => {
    // Regression (#1592): restoring after a push re-marked a.ts Viewed though
    // the push changed it.
    expect(restorableViewedFiles(['src/a.ts', 'src/gone.ts'], true, files)).toEqual(['src/gone.ts']);
  });

  test('on the same patch every mark is restored', () => {
    expect(restorableViewedFiles(['src/a.ts'], false, files)).toEqual(['src/a.ts']);
  });
});
