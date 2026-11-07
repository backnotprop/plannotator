/**
 * Where other people's threads go on the PR page's diff. What regresses: a thread on a line this diff shows drawn
 * anywhere else; a thread whose line moved, or on the whole file, dropped from the page (it goes to the top of its
 * file, saying why); a whole stack's diff drawing a base-side thread on a line of another base; a push or a count of
 * threads folding threads; a file's open threads miscounted; a long thread cut without saying how much.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxPullDetailComment, InboxPullThread } from '@plannotator/core/inbox-types';
import { foldedWhy, patchLines, placeThreads, shownComments, threadKey } from './threadPlaces';

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
      thread('file', { line: null }),
      thread('far', { line: 40 }),
      thread('pushed', { line: 40, outdated: true }),
    ])).toEqual([
      ['moved', 'outdated', 'new', 1],
      ['file', 'file', 'new', 1],
      ['far', 'elsewhere', 'new', 1],
      ['pushed', 'outdated', 'new', 1],
    ]);
  });

  test('a deleted file: its first removed line', () => {
    expect(where([thread('d', { file: 'src/gone.ts', line: null })])).toEqual([['d', 'file', 'old', 1]]);
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
