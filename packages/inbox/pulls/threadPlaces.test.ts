/**
 * Where other people's threads go on the PR page's diff. What regresses: a thread on a line this diff shows drawn
 * anywhere else; a thread whose line moved dropped from the page (it goes to the top of its file, saying why); a thread
 * on the whole file put on a line, or its band out of time order; a whole stack's diff drawing a base-side thread on a line of another base; a push or a count of
 * threads folding threads; a file's open threads miscounted; a long thread cut without saying how much.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxPullDetailComment, InboxPullThread } from '@plannotator/core/inbox-types';
import { fileThreadKey, foldedWhy, patchLines, placeThreads, shownComments, threadKey } from './threadPlaces';

// src/a.ts: line 3 changes; the hunk shows new lines 1-5 and old lines 1-5. src/gone.ts is deleted (old lines 1-2).
const files = [
  { path: 'src/a.ts', patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,5 +1,5 @@\n one\n two\n-three\n+THREE\n four\n five\n' },
  { path: 'src/gone.ts', patch: 'diff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n' },
];
const said = (id: string, fields: Partial<InboxPullDetailComment> = {}): InboxPullDetailComment => ({ id, author: 'kim', at: '2026-11-01T00:00:00Z', body: id, url: `https://x/${id}`, ...fields });
const thread = (id: string, fields: Partial<InboxPullThread> = {}): InboxPullThread => ({
  id, file: 'src/a.ts', line: 3, start_line: null, side: 'new', resolved: false, outdated: false, comments: [said(`${id}-1`)], ...fields,
});
const where = (threads: InboxPullThread[], scope: 'layer' | 'stack' = 'layer') =>
  placeThreads(threads, files, scope).placed.map((p) => [p.thread.id, p.where, p.side, p.line]);
const onFiles = (threads: InboxPullThread[], scope: 'layer' | 'stack' = 'layer') =>
  placeThreads(threads, files, scope).onFiles.map(({ thread: t, side }) => [t.id, t.file, side]);

describe('placing', () => {
  test('on the line it is about, either side', () => {
    expect(where([thread('t1'), thread('t2', { line: 3, side: 'old' }), thread('t3', { line: 5 })])).toEqual([
      ['t1', 'line', 'new', 3],
      ['t2', 'line', 'old', 3],
      ['t3', 'line', 'new', 5],
    ]);
  });

  test('a line this diff does not draw: at the top of its file, saying why, never dropped', () => {
    expect(where([
      thread('moved', { line: null, outdated: true }),
      thread('far', { line: 40 }),
      thread('pushed', { line: 40, outdated: true }),
    ])).toEqual([
      ['moved', 'outdated', 'new', 1],
      ['far', 'elsewhere', 'new', 1],
      ['pushed', 'outdated', 'new', 1],
    ]);
  });

  test('on the whole file: never on a line, but in its file\'s bands, in the time they started, and counted', () => {
    const at = (minute: number) => [said(`m${minute}`, { at: `2026-11-01T00:${String(minute).padStart(2, '0')}:00Z` })];
    const threads = [
      thread('later', { line: null, comments: at(30) }),
      thread('on-line'),
      thread('earlier', { line: null, comments: at(5), resolved: true }),
      thread('gone', { file: 'src/gone.ts', line: null, comments: at(45) }),
    ];
    const { placed, onFiles: bands, open } = placeThreads(threads, files, 'layer');
    expect(placed.map((p) => p.thread.id)).toEqual(['on-line']);
    expect(bands.map(({ thread: t, side }) => [t.id, t.file, side])).toEqual([['earlier', 'src/a.ts', 'new'], ['later', 'src/a.ts', 'new'], ['gone', 'src/gone.ts', 'old']]);
    // The resolved one is drawn but not counted.
    expect(open.get('src/a.ts')).toBe(2);
    expect(open.get('src/gone.ts')).toBe(1);
    // An outdated one with no line is about lines a push moved: the top of its file, as before.
    expect(onFiles([thread('o', { line: null, outdated: true })])).toEqual([]);
    // In Whole stack too, and never for a file this diff does not change.
    expect(onFiles([thread('s', { line: null })], 'stack')).toEqual([['s', 'src/a.ts', 'new']]);
    expect(onFiles([thread('x', { file: 'src/other.ts', line: null })])).toEqual([]);
  });

  test('a deleted file: its first removed line', () => {
    expect(where([thread('d', { file: 'src/gone.ts', line: 9 })])).toEqual([['d', 'elsewhere', 'old', 1]]);
    expect(where([thread('d', { file: 'src/gone.ts', line: 2, side: 'old' })])).toEqual([['d', 'line', 'old', 2]]);
  });

  test("a whole stack's diff runs from the stack's base: a base-side thread is not on its line there", () => {
    expect(where([thread('old', { side: 'old' }), thread('new')], 'stack')).toEqual([
      ['old', 'elsewhere', 'new', 1],
      ['new', 'line', 'new', 3],
    ]);
  });

  test('a file this diff does not change: not on the page (the Details panel has it)', () => {
    expect(where([thread('x', { file: 'src/other.ts' })])).toEqual([]);
  });

  test('every thread is placed and each open one counted, past any count', () => {
    const many = Array.from({ length: 40 }, (_, i) => thread(`t${i}`, { resolved: i % 4 === 0, line: (i % 5) + 1 }));
    const { placed, open } = placeThreads([...many, thread('x', { file: 'src/other.ts' })], files, 'layer');
    expect(placed).toHaveLength(40);
    expect(open.get('src/a.ts')).toBe(30);
    expect(open.has('src/other.ts')).toBe(false);
  });

  test('a file the diff draws no line of (a binary file): a thread on a line is not drawn, so not counted; one on the whole file has its band', () => {
    const binary = [{ path: 'img/logo.png', patch: 'diff --git a/img/logo.png b/img/logo.png\nBinary files differ\n' }];
    const lined = placeThreads([thread('b', { file: 'img/logo.png', line: 4 })], binary, 'layer');
    expect(lined.placed).toEqual([]);
    expect(lined.open.has('img/logo.png')).toBe(false);
    const whole = placeThreads([thread('w', { file: 'img/logo.png', line: null })], binary, 'layer');
    expect(whole.onFiles.map(({ thread: t, lines }) => [t.id, lines])).toEqual([['w', false]]);
    expect(whole.open.get('img/logo.png')).toBe(1);
  });
});

describe('folding', () => {
  test('resolved, or only bots: one line that says why; a push or a crowded file never folds a thread', () => {
    expect(foldedWhy(thread('r', { resolved: true }))).toBe('resolved');
    expect(foldedWhy(thread('b', { comments: [said('b1', { bot: true }), said('b2', { bot: true })] }))).toBe('bot');
    expect(foldedWhy(thread('mixed', { comments: [said('m1', { bot: true }), said('m2')] }))).toBeNull();
    expect(foldedWhy(thread('o', { outdated: true, line: null }))).toBeNull();
    const crowded = Array.from({ length: 12 }, (_, i) => thread(`c${i}`));
    expect(crowded.map(foldedWhy).every((why) => why === null)).toBe(true);
  });

  test('a long thread: its first and last, and how many between; whole when asked', () => {
    expect(shownComments([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], between: 0 });
    expect(shownComments([1, 2, 3, 4, 5, 6, 7, 8, 9], false)).toEqual({ shown: [1, 9], between: 7 });
    expect(shownComments([1, 2, 3, 4], true)).toEqual({ shown: [1, 2, 3, 4], between: 0 });
  });
});

test("a thread's drawing key moves with a new comment, an edit, resolving or a hide, and only then", () => {
  const placed = (t: InboxPullThread) => placeThreads([t], files, 'layer').placed[0]!;
  const base = threadKey(placed(thread('t')));
  expect(threadKey(placed(thread('t')))).toBe(base);
  expect(threadKey(placed(thread('t', { comments: [said('t-1'), said('t-2')] })))).not.toBe(base);
  expect(threadKey(placed(thread('t', { comments: [said('t-1', { body: 'edited' })] })))).not.toBe(base);
  expect(threadKey(placed(thread('t', { resolved: true })))).not.toBe(base);
  expect(threadKey(placed(thread('t', { comments: [said('t-1', { hidden: 'spam' })] })))).not.toBe(base);
});

test("a patch's drawn lines on each side", () => {
  const lines = patchLines(files[0]!.patch);
  expect([...lines.new]).toEqual([1, 2, 3, 4, 5]);
  expect([...lines.old]).toEqual([1, 2, 3, 4, 5]);
  expect(lines.first).toEqual({ line: 1, side: 'new' });
});

test('a very long deleted file: its first removed line, with no limit on how many', () => {
  const rows = Array.from({ length: 1_000_000 }, (_, i) => `-row ${i}`).join('\n');
  const lines = patchLines(`diff --git a/big b/big\ndeleted file mode 100644\n--- a/big\n+++ /dev/null\n@@ -1,1000000 +0,0 @@\n${rows}\n`);
  expect(lines.first).toEqual({ line: 1, side: 'old' });
  expect(lines.old.size).toBe(1_000_000);
});

test("a thread on a whole file is drawn again when its words or state move, and not otherwise", () => {
  const base = fileThreadKey(thread('w', { line: null }));
  expect(fileThreadKey(thread('w', { line: null }))).toBe(base);
  expect(fileThreadKey(thread('w', { line: null, comments: [said('w-1'), said('w-2')] }))).not.toBe(base);
  expect(fileThreadKey(thread('w', { line: null, resolved: true }))).not.toBe(base);
});
