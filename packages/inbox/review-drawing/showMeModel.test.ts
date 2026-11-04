/**
 * Show me's pure parts. What regresses if these fail: a picture's part opens
 * the wrong chapter (or none, when one holds the file), or round 2's Overview
 * tags parts the agent did not change (or misses one it did).
 */
import { describe, expect, test } from 'bun:test';
import { askShownQuestion } from '../ask/askModel';
import { anchorLines, anchorPart, changedMarks, chapterOf, newSideLines, showMeAbout, showMePlace } from './showMeModel';

describe('Show me model', () => {
  test("a part opens the chapter that holds its file, else All files (null)", () => {
    const chapters = [{ diffs: [{ file: 'a.ts' }] }, { diffs: [{ file: 'b.ts' }, { file: 'src/retry.ts' }] }];
    expect(chapterOf(chapters, 'src/retry.ts')).toBe(1);
    expect(chapterOf(chapters, 'unplaced.ts')).toBeNull();
  });

  test("round 2's changed parts: new words or a new id, never a part that kept both", () => {
    const before = '<div data-mark="pick">Pick</div><div data-mark="wait">Wait 1s</div><div data-mark="gone">Gone</div>';
    const after = '<div data-mark="pick">Pick</div><div data-mark="wait">Wait, then back off</div><div data-mark="new">Dead letter</div>';
    expect([...changedMarks([before], [after])].sort()).toEqual(['new', 'wait']);
  });

  // Round 2 for Show me: a picture stays as asked; its parts follow moved lines, and lines rewritten since are "changed since asked".
  test("round 2: a part follows its moved lines, keeps unchanged ones, and lines rewritten since are changed", () => {
    const round1 = newSideLines(['@@ -1,3 +1,4 @@', ' a', '+pick()', '+wait()', ' b', ''].join('\n'));
    // Round 2 adds two lines above pick() and rewrites wait().
    const round2 = newSideLines(['@@ -1,3 +1,6 @@', ' a', '+log()', '+log2()', '+pick()', '+waitWithJitter()', ' b', ''].join('\n'));
    expect(round1.get(2)).toBe('pick()');
    expect(anchorPart({ path: 'w.ts', line: 2 }, round1, round2)).toEqual({ now: { path: 'w.ts', line: 4 }, changed: false });
    expect(anchorPart({ path: 'w.ts', line: 3 }, round1, round2)).toEqual({ now: { path: 'w.ts', line: 3 }, changed: true });
    expect(anchorPart({ path: 'w.ts', line: 1 }, round1, round2)).toEqual({ now: { path: 'w.ts', line: 1 }, changed: false });
  });

  // The Ask window shows a Show me as the person asked it: the agent's request to draw (with its CLI line) never shows.
  test("the Ask window reads a Show me turn as the person's words, a plain turn as its question", () => {
    const show_me = { review: 'msg_1', file: 'src/jobs/retry-worker.ts', lines: [16, 18] as [number, number], round: 1, words: 'after the third failure?' };
    expect(askShownQuestion({ question: 'The reviewer pressed Show me… plannotator review draw …', kind: 'show_me', show_me })).toBe('Show me on retry-worker.ts lines 16–18: after the third failure?');
    expect(askShownQuestion({ question: '…', kind: 'show_me', show_me: { review: 'msg_1', file: null, lines: null, round: 1 } })).toBe('Show me on the whole review');
    expect(askShownQuestion({ question: 'Why five attempts?' })).toBe('Why five attempts?');
  });

  test('the sheet names lines with an en dash, and the Overview as the whole review', () => {
    expect(showMePlace('src/retry-worker.ts', [16, 18])).toBe('retry-worker.ts lines 16–18');
    expect(showMePlace(null, null)).toBe('the whole review');
  });
  test("Show me again asks about the lines where they are now: moved, they follow; changed or unseen, none", () => {
    const before = new Map([[16, 'a'], [17, 'b'], [18, 'c']]);
    expect(anchorLines([16, 18], before, new Map([[17, 'a'], [18, 'b'], [19, 'c']]))).toEqual([17, 19]);
    expect(anchorLines([16, 18], before, new Map([[16, 'a'], [17, 'B'], [18, 'c']]))).toBeNull();
    expect(anchorLines([15, 16], before, new Map([[15, 'z'], [16, 'a']]))).toBeNull();
  });

  test("a Show me opens what was asked about the same place: overlapping lines of the same file, or the whole review", () => {
    expect(showMeAbout({ file: 'w.ts', lines: [16, 18] }, { file: 'w.ts', lines: [18, 20] })).toBe(true);
    expect(showMeAbout({ file: 'w.ts', lines: [16, 18] }, { file: 'w.ts', lines: [19, 20] })).toBe(false);
    expect(showMeAbout({ file: 'x.ts', lines: [16, 18] }, { file: 'w.ts', lines: [16, 18] })).toBe(false);
    expect(showMeAbout({ file: null, lines: null }, { file: null, lines: null })).toBe(true);
    expect(showMeAbout({ file: 'w.ts', lines: [1, 2] }, { file: null, lines: null })).toBe(false);
  });
});
