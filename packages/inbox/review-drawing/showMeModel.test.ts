import { describe, expect, test } from 'bun:test';
import { askShownQuestion } from '../ask/askModel';
import { FIXTURE_V2_HTML } from '@plannotator/core/guide-format-fixtures';
import { boardParents, boardPressWaits, boardRows, reviewDrawnOn, reviewLines, anchorLines, anchorPart, overviewPicture, changedMarks, chapterOf, earlierLinesNow, newSideLines, partLanding, showMeEnded, showMeSamePlace, shiftLines, waitingShowMe } from './showMeModel';

describe('Show me model', () => {
  test("a board's Show me never throws away words typed in the review's Show me box: it waits behind them", () => {
    expect(boardPressWaits({ words: 'why this lock?', turn: null }, false)).toBe('wait');
    expect(boardPressWaits({ words: 'x', turn: 'turn_1' }, false)).toBe('wait');
    expect(boardPressWaits(null, true)).toBe('wait');
    expect(boardPressWaits({ words: '  ', turn: null }, false)).toBe('go');
    expect(boardPressWaits(null, false)).toBe('go');
  });

  test("a part drawn on this review lands on lines its diff shows; lines it does not show go to the board's own viewer", () => {
    const now = new Map([['w.ts', new Map([[16, 'a'], [17, 'b']])]]);
    expect(partLanding({ path: 'w.ts', line: 16, lineEnd: 17 }, now)).toEqual([16, 17]);
    expect(partLanding({ path: 'w.ts', line: 9999 }, now)).toBeNull();
    expect(partLanding({ path: 'other.ts', line: 16 }, now)).toBeNull();
  });

  test("a part drawn on an earlier review lands where its code is now, never on its old numbers", () => {
    const earlier = new Map([['w.ts', new Map([[16, 'a'], [17, 'b'], [18, 'c']])]]);
    const moved = new Map([['w.ts', new Map([[6, 'log'], [17, 'a'], [18, 'b'], [19, 'c']])]]);
    expect(partLanding({ path: 'w.ts', line: 16, lineEnd: 18 }, moved, { lines: earlier })).toEqual([17, 19]);
    const rewritten = new Map([['w.ts', new Map([[16, 'x'], [17, 'y'], [18, 'z']])]]);
    expect(partLanding({ path: 'w.ts', line: 16, lineEnd: 18 }, rewritten, { lines: earlier })).toBe('changed');
    expect(partLanding({ path: 'w.ts', line: 16 }, moved, { lines: undefined })).toBe('changed');
    expect(partLanding({ path: 'w.ts', line: 400 }, moved, { lines: earlier })).toBeNull();
    expect(partLanding({ path: 'gone.ts', line: 16 }, moved, { lines: earlier })).toBeNull();
  });

  test("round 2: a part follows its moved lines, keeps unchanged ones, and lines rewritten since are changed", () => {
    const round1 = newSideLines(['@@ -1,3 +1,4 @@', ' a', '+pick()', '+wait()', ' b', ''].join('\n'));
    const round2 = newSideLines(['@@ -1,3 +1,6 @@', ' a', '+log()', '+log2()', '+pick()', '+waitWithJitter()', ' b', ''].join('\n'));
    expect(round1.get(2)).toBe('pick()');
    expect(anchorPart({ path: 'w.ts', line: 2 }, round1, round2)).toEqual({ now: { path: 'w.ts', line: 4 }, changed: false });
    expect(anchorPart({ path: 'w.ts', line: 3 }, round1, round2)).toEqual({ now: { path: 'w.ts', line: 3 }, changed: true });
    expect(anchorPart({ path: 'w.ts', line: 1 }, round1, round2)).toEqual({ now: { path: 'w.ts', line: 1 }, changed: false });
  });

  test("Show me again asks about the lines where they are now: moved, they follow; changed or unseen, none", () => {
    const before = new Map([[16, 'a'], [17, 'b'], [18, 'c']]);
    expect(anchorLines([16, 18], before, new Map([[17, 'a'], [18, 'b'], [19, 'c']]))).toEqual([17, 19]);
    expect(anchorLines([16, 18], before, new Map([[16, 'a'], [17, 'B'], [18, 'c']]))).toBeNull();
    expect(anchorLines([15, 16], before, new Map([[15, 'z'], [16, 'a']]))).toBeNull();
  });

  test("an earlier round's changed lines are found where the code around them moved, never at their old numbers (the delta-5 repro)", () => {
    const round1 = new Map(Array.from({ length: 100 }, (_, i) => [i + 1, `line ${i + 1}`] as const));
    const round2 = new Map<number, string>();
    for (let i = 1; i <= 30; i++) round2.set(i, `added ${i}`);
    for (let i = 1; i <= 100; i++) round2.set(i + 30, i === 51 ? 'line 51, edited' : `line ${i}`);
    expect(anchorLines([50, 52], round1, round2)).toBeNull();
    expect(shiftLines([50, 52], round1, round2)).toEqual([80, 82]);
    const now = earlierLinesNow([50, 52], round1, round2)!;
    expect(now).toEqual([80, 82]);
    expect(showMeSamePlace({ file: 'w.ts', lines: now }, { file: 'w.ts', lines: [50, 52] })).toBe(false);
    expect(showMeSamePlace({ file: 'w.ts', lines: now }, { file: 'w.ts', lines: [80, 82] })).toBe(true);
    expect(earlierLinesNow([10, 12], round1, round2)).toEqual([40, 42]);
    expect(earlierLinesNow([50, 52], undefined, round2)).toBeNull();
    const swapped = new Map(round2);
    swapped.set(1, 'line 49');
    swapped.set(79, 'added 1');
    expect(shiftLines([50, 52], round1, swapped)).toEqual([80, 82]);
  });

  test("an earlier round's lines are not placed on other code: a deleted block, a line added beside it, a repeated line (the delta-6 repros)", () => {
    const round1 = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, `line ${i + 1}`] as const));
    const round2 = (...texts: string[]) => new Map(texts.map((text, i) => [i + 1, text] as const));
    const rest = (from: number) => Array.from({ length: 11 - from }, (_, i) => `line ${from + i}`);
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', ...rest(7)))).toBeNull();
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'added', 'line 4', 'line 5, edited', 'line 6', ...rest(7)))).toEqual([5, 7]);
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'added', 'edited 4', 'edited 5', 'edited 6', ...rest(7)))).toBeNull();
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'line 4', 'added', 'line 5, edited', 'line 6', ...rest(7)))).toEqual([4, 7]);
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'edited 4', 'edited 5', 'edited 6', ...rest(7)))).toEqual([4, 6]);
    const before = new Map([[197, 'function kept() {'], [198, '  return null;'], [199, '}'], [200, 'function gone() {'], [201, '  work();'], [202, '  done();'], [203, 'export default gone;']]);
    const after = new Map([[196, 'const a = 1;'], [197, 'function other() {'], [198, '  if (x) foo();'], [199, '  return null;'], [200, '}'], [201, ''], [202, 'const b = 2;']]);
    expect(earlierLinesNow([200, 202], before, after)).toBeNull();
  });

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

  test("the Ask window reads a Show me turn as the person's words, a plain turn as its question", () => {
    const show_me = { review: 'msg_1', file: 'src/jobs/retry-worker.ts', lines: [16, 18] as [number, number], round: 1, words: 'after the third failure?' };
    expect(askShownQuestion({ question: 'The reviewer pressed Show me… plannotator review draw …', kind: 'show_me', show_me })).toBe('Show me on retry-worker.ts lines 16–18: after the third failure?');
    expect(askShownQuestion({ question: '…', kind: 'show_me', show_me: { review: 'msg_1', file: null, lines: null, round: 1 } })).toBe('Show me on the whole review');
    expect(askShownQuestion({ question: 'Why five attempts?' })).toBe('Why five attempts?');
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
    expect(waitingShowMe([turn('t-noconn')], 'msg_r', place, null, null)).toBeUndefined();
    expect(waitingShowMe([turn('t-gone')], 'msg_r', place, 't-other', null)).toBeUndefined();
    expect(waitingShowMe([turn('t-run')], 'msg_r', place, 't-run', null)?.id).toBe('t-run');
    expect(waitingShowMe([turn('t-live')], 'msg_r', place, null, 't-live')?.id).toBe('t-live');
  });
  test("only a drawn (version-3) overview is a Shape picture; every version-2 html diagram keeps the viewer's note", () => {
    expect(overviewPicture(FIXTURE_V2_HTML.guide.overview?.diagram)).toBeNull();
    expect(overviewPicture({ kind: 'html', source: '<div data-mark="g" data-code="src/auth.ts#L1">guard</div>' })).toBeNull();
    expect(overviewPicture({ kind: 'mermaid', source: 'flowchart LR' })).toBeNull();
    const drawn = { kind: 'html' as const, source: '<div data-mark="g">guard</div>', width: 800, height: 360 };
    expect(overviewPicture(drawn)).toBe(drawn);
  });

  test("a Show me with a board has not ended; with no board or answer, and nothing running, it has", () => {
    const idle = { running: false, busy: false };
    expect(showMeEnded({ shape: 'shp_1' }, idle)).toBe(false);
    expect(showMeEnded({}, idle)).toBe(true);
    expect(showMeEnded({}, { running: true, busy: false })).toBe(false);
    expect(showMeEnded({ answer: 'words' }, idle)).toBe(false);
    expect(showMeEnded({ stopped: true }, idle)).toBe(false);
  });
});

describe('which review a version counts its lines in', () => {
  const messages = [
    { id: 'ask', created_at: '2026-01-01T10:00:00.000Z' },
    { id: 'r1', created_at: '2026-01-01T11:00:00.000Z', guide: { review: {} } },
    { id: 'reply1', created_at: '2026-01-01T12:00:00.000Z' },
    { id: 'r2', created_at: '2026-01-01T13:00:00.000Z', guide: { review: {} } },
    { id: 'reply2', created_at: '2026-01-01T14:00:00.000Z' },
  ];
  test('the newest review at or before the message it was stored through', () => {
    expect(reviewDrawnOn('r1', messages, undefined)).toBe('r1');
    expect(reviewDrawnOn('reply1', messages, undefined)).toBe('r1');
    expect(reviewDrawnOn('r2', messages, 'r1')).toBe('r2');
    expect(reviewDrawnOn('reply2', messages, undefined)).toBe('r2');
  });
  test('stored through nothing, or through something before any review: the review its Show me names', () => {
    expect(reviewDrawnOn(null, messages, 'r1', '2026-01-01T15:00:00.000Z')).toBe('r1');
    expect(reviewDrawnOn('ask', messages, 'r1')).toBe('r1');
    expect(reviewDrawnOn('elsewhere', messages, 'r1')).toBe('r1');
  });
  test('no Show me made it: the newest review when the version was stored, wherever it was stored through', () => {
    expect(reviewDrawnOn(null, messages, undefined, '2026-01-01T12:30:00.000Z')).toBe('r1');
    expect(reviewDrawnOn(null, messages, undefined, '2026-01-01T13:30:00.000Z')).toBe('r2');
    expect(reviewDrawnOn('ask', messages, undefined, '2026-01-01T12:30:00.000Z')).toBe('r1');
    expect(reviewDrawnOn('elsewhere', messages, undefined, '2026-01-01T13:30:00.000Z')).toBe('r2');
    expect(reviewDrawnOn(null, messages, undefined, '2026-01-01T11:00:00.000Z')).toBe('r1');
  });
  test('stored before any review, or with no time: none', () => {
    expect(reviewDrawnOn(null, messages, undefined, '2026-01-01T10:30:00.000Z')).toBeNull();
    expect(reviewDrawnOn('ask', messages, undefined, '2026-01-01T10:30:00.000Z')).toBeNull();
    expect(reviewDrawnOn(null, messages, undefined)).toBeNull();
  });
});

describe('a part whose lines mean nothing here', () => {
  const now = new Map([['w.ts', new Map([[16, 'a'], [17, 'b']])], ['gone.ts', new Map<number, string>()]]);
  test('drawn on none of these reviews: the board\'s own viewer, never its numbers, even when this diff has those lines', () => {
    expect(partLanding({ path: 'w.ts', line: 16 }, now, null)).toBeNull();
    expect(partLanding({ path: 'other.ts', line: 16 }, now, null)).toBeNull();
    expect(partLanding({ path: 'gone.ts', line: 2 }, now, null)).toBe('changed');
  });
  test('a file the review deletes: the note, in any review', () => {
    expect(partLanding({ path: 'gone.ts', line: 2 }, now)).toBe('changed');
    expect(partLanding({ path: 'gone.ts', line: 2 }, now, { lines: new Map() })).toBe('changed');
  });
  test('a file with no hunks shows no lines and hides none: the board opens it', () => {
    const lines = reviewLines([{ path: 'moved.ts', patch: 'diff --git a/o.ts b/moved.ts\nsimilarity index 100%\nrename from o.ts\nrename to moved.ts\n' }]);
    expect(partLanding({ path: 'moved.ts', line: 2 }, lines)).toBeNull();
  });
});

describe('a thread\'s boards, made from each other', () => {
  const made = (shape: string, from: string) => ({ shape, show_me: { part: { board: from } } });
  const boards = (...ids: string[]) => ids.map((id) => ({ id, title: id.toUpperCase() }));

  test('three levels and a sibling: each under the board it came from, a board with no link at the top', () => {
    const parents = boardParents([made('b', 'a'), made('c', 'b'), made('d', 'a')]);
    const rows = boardRows(boards('a', 'b', 'c', 'd', 'e'), parents);
    expect(rows.map((row) => [row.id, row.depth, row.parent])).toEqual([['a', 0, null], ['b', 1, 'a'], ['c', 2, 'b'], ['d', 1, 'a'], ['e', 0, null]]);
  });

  test('every board is listed, however many and however deep', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `b${String(i).padStart(2, '0')}`);
    const turns = ids.slice(1).map((id, i) => made(id, ids[i]!));
    const rows = boardRows(ids.map((id) => ({ id, title: id })), boardParents(turns));
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(rows.at(-1)!.depth).toBe(39);
  });

  test('Show me again and an agent that moved the board it was on change no link, and nothing can loop', () => {
    const parents = boardParents([made('b', 'a'), made('b', 'c'), made('a', 'a'), made('a', 'b')]);
    expect([...parents]).toEqual([['b', 'a']]);
  });

  test('a turn with no board yet, and a plain Show me, link nothing', () => {
    expect(boardParents([{ show_me: { part: { board: 'a' } } }, { shape: 'b', show_me: {} }, { shape: 'c' }]).size).toBe(0);
  });

  test('a board whose source is gone from the list stays listed, at the top', () => {
    const rows = boardRows(boards('b'), boardParents([made('b', 'gone')]));
    expect(rows).toEqual([{ id: 'b', title: 'B', depth: 0, parent: null }]);
  });

  test('a Show me from a board is never the same place as the review\'s Overview, which also has no file', () => {
    const fromBoard = { file: null, lines: null, part: { board: 'a' } };
    expect(showMeSamePlace(fromBoard, { file: null, lines: null })).toBe(false);
    expect(showMeSamePlace({ file: null, lines: null }, { file: null, lines: null })).toBe(true);
  });
});
