/**
 * Show me's pure parts. What regresses if these fail: a picture's part opens
 * the wrong chapter (or none, when one holds the file), or round 2's Overview
 * tags parts the agent did not change (or misses one it did).
 */
import { describe, expect, test } from 'bun:test';
import { askShownQuestion } from '../ask/askModel';
import { FIXTURE_V2_HTML } from '@plannotator/core/guide-format-fixtures';
import { anchorLines, anchorPart, overviewPicture, changedMarks, chapterOf, earlierLinesNow, newSideLines, showMeEnded, showMePlace, showMeSamePlace, shiftLines, waitingShowMe } from './showMeModel';

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

  test("this round's picture opens again only for the same place: inside its lines, or most of the lines both cover", () => {
    const asked = { file: 'w.ts', lines: [16, 18] as [number, number] };
    expect(showMeSamePlace(asked, { file: 'w.ts', lines: [17, 17] })).toBe(true);
    expect(showMeSamePlace(asked, { file: 'w.ts', lines: [15, 18] })).toBe(true);
    expect(showMeSamePlace(asked, { file: 'w.ts', lines: [1, 200] })).toBe(false);
    expect(showMeSamePlace(asked, { file: 'w.ts', lines: [18, 30] })).toBe(false);
    expect(showMeSamePlace({ file: null, lines: null }, { file: null, lines: null })).toBe(true);
  });

  test("a Show me waits only while the agent draws it; one the Inbox kept unanswered never locks its lines", () => {
    const place = { file: 'w.ts', lines: [16, 18] as [number, number] };
    const turn = (id: string) => ({ id, kind: 'show_me' as const, show_me: { review: 'msg_r', file: 'w.ts', lines: [16, 18] as [number, number] } });
    // POST …/ask answered `provider_id: null, reason: "no_connection"`: the turn is kept, nothing runs.
    expect(waitingShowMe([turn('t-noconn')], 'msg_r', place, null, null)).toBeUndefined();
    // The session went away before a word (a failure with no words writes nothing): the same kept turn, a slot freed.
    expect(waitingShowMe([turn('t-gone')], 'msg_r', place, 't-other', null)).toBeUndefined();
    // Drawn now: the Inbox's running turn, or this window's own stream.
    expect(waitingShowMe([turn('t-run')], 'msg_r', place, 't-run', null)?.id).toBe('t-run');
    expect(waitingShowMe([turn('t-live')], 'msg_r', place, null, 't-live')?.id).toBe('t-live');
  });
  test("only a drawn (version-3) overview is a Shape picture; every version-2 html diagram keeps the viewer's note", () => {
    // The format's own `code:` link picture, and one that would pass Shape's rules: both as before Show me.
    expect(overviewPicture(FIXTURE_V2_HTML.guide.overview?.diagram)).toBeNull();
    expect(overviewPicture({ kind: 'html', source: '<div data-mark="g" data-code="src/auth.ts#L1">guard</div>' })).toBeNull();
    expect(overviewPicture({ kind: 'mermaid', source: 'flowchart LR' })).toBeNull();
    const drawn = { kind: 'html' as const, source: '<div data-mark="g">guard</div>', width: 800, height: 360 };
    expect(overviewPicture(drawn)).toBe(drawn);
  });

  test("an earlier round's changed lines are found where the code around them moved, never at their old numbers (the delta-5 repro)", () => {
    // Round 1: lines 1–100. Round 2: 30 lines added above, and old line 51 edited.
    const round1 = new Map(Array.from({ length: 100 }, (_, i) => [i + 1, `line ${i + 1}`] as const));
    const round2 = new Map<number, string>();
    for (let i = 1; i <= 30; i++) round2.set(i, `added ${i}`);
    for (let i = 1; i <= 100; i++) round2.set(i + 30, i === 51 ? 'line 51, edited' : `line ${i}`);
    expect(anchorLines([50, 52], round1, round2)).toBeNull();
    expect(shiftLines([50, 52], round1, round2)).toEqual([80, 82]);
    const now = earlierLinesNow([50, 52], round1, round2)!;
    expect(now).toEqual([80, 82]);
    // 50–52 now holds old lines 20–22: not the picture's place; 80–82 is.
    expect(showMeSamePlace({ file: 'w.ts', lines: now }, { file: 'w.ts', lines: [50, 52] })).toBe(false);
    expect(showMeSamePlace({ file: 'w.ts', lines: now }, { file: 'w.ts', lines: [80, 82] })).toBe(true);
    // Unchanged lines that moved are followed as before; with nothing to go by (the earlier diff unread), no place.
    expect(earlierLinesNow([10, 12], round1, round2)).toEqual([40, 42]);
    expect(earlierLinesNow([50, 52], undefined, round2)).toBeNull();
    // A line that moved past the others is no guide: the offset comes from the lines kept in order.
    const swapped = new Map(round2);
    swapped.set(1, 'line 49');
    swapped.set(79, 'added 1');
    expect(shiftLines([50, 52], round1, swapped)).toEqual([80, 82]);
  });

  test("an earlier round's lines are not placed on other code: a deleted block, a line added beside it, a repeated line (the delta-6 repros)", () => {
    const round1 = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, `line ${i + 1}`] as const));
    const round2 = (...texts: string[]) => new Map(texts.map((text, i) => [i + 1, text] as const));
    const rest = (from: number) => Array.from({ length: 11 - from }, (_, i) => `line ${from + i}`);
    // (a) Lines 4–6 deleted, the line above kept: 4–6 is other code now.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', ...rest(7)))).toBeNull();
    // (b) A line added between the guide and the block, line 5 edited: the block is at 5–7.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'added', 'line 4', 'line 5, edited', 'line 6', ...rest(7)))).toEqual([5, 7]);
    // The same with every line of the block edited: the added line may be part of it or not, so no place.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'added', 'edited 4', 'edited 5', 'edited 6', ...rest(7)))).toBeNull();
    // A line added inside the block, its ends kept (the fix inside what the picture showed): the block grew.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'line 4', 'added', 'line 5, edited', 'line 6', ...rest(7)))).toEqual([4, 7]);
    // Edited in place, the lines around it kept: the same numbers.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'edited 4', 'edited 5', 'edited 6', ...rest(7)))).toEqual([4, 6]);
    // (c) `return null;` and `}` are shown once in each diff, but in other functions: the block is gone, nothing below agrees.
    const before = new Map([[197, 'function kept() {'], [198, '  return null;'], [199, '}'], [200, 'function gone() {'], [201, '  work();'], [202, '  done();'], [203, 'export default gone;']]);
    const after = new Map([[196, 'const a = 1;'], [197, 'function other() {'], [198, '  if (x) foo();'], [199, '  return null;'], [200, '}'], [201, ''], [202, 'const b = 2;']]);
    expect(earlierLinesNow([200, 202], before, after)).toBeNull();
  });

  test("a Show me that named its picture has not ended, even before this window has read the picture", () => {
    const idle = { running: false, busy: false, drawn: false };
    expect(showMeEnded({}, idle)).toBe(true);
    expect(showMeEnded({ drawing: 'drw_1' }, idle)).toBe(false);
    // The list, read again for it, still lacks the picture: it never comes, and the box does not wait on it.
    expect(showMeEnded({ drawing: 'drw_1' }, { ...idle, lost: true })).toBe(true);
    expect(showMeEnded({ drawing: 'drw_1', answer: 'words' }, { ...idle, lost: true })).toBe(false);
    expect(showMeEnded({ answer: '' }, idle)).toBe(false);
    expect(showMeEnded({ stopped: true }, idle)).toBe(false);
    expect(showMeEnded({}, { ...idle, running: true })).toBe(false);
    expect(showMeEnded({}, { ...idle, busy: true })).toBe(false);
    expect(showMeEnded({}, { ...idle, drawn: true })).toBe(false);
  });
});
