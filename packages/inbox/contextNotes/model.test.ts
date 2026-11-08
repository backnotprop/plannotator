/**
 * Context notes' one model (approval "inbox-context-notes"): which writer's
 * notes land on which lines of a review. What regresses: a note drawn on lines
 * that hold other code now (an earlier review's numbers, a place outside the
 * diff), a medium or low risk marking code, an Ask's answer pinned to the lines
 * it was asked about (the owner: it stays in the thread), the stale line naming
 * the wrong round.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxPullRiskJudgment } from '@plannotator/core/inbox-types';
import { askRiskPlaces, guideNotes, noteHolds, noteReviews, pictureNotes, RISK_PLACES_ASK_MS, riskNotes, staleWords, takeRiskPlaces, threadNotes, type NoteFile, type NoteMessage } from './model';

const patch = (...body: string[]) => `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,${body.length} @@\n${body.join('\n')}\n`;
/** Round 1: new lines 1 one, 2 two, 3 three, 4 four. */
const ROUND_1: NoteFile[] = [{ path: 'a.ts', patch: patch(' one', '+two', ' three', ' four') }];
/** Round 2: two lines above, "two" moved to line 4, text the same. */
const ROUND_2: NoteFile[] = [{ path: 'a.ts', patch: patch(' one', '+zero', '+zero2', '+two', ' three', ' four') }];
/** Round 3: "two" rewritten in place, its neighbours unchanged. */
const ROUND_3: NoteFile[] = [{ path: 'a.ts', patch: patch(' one', '+TWO', ' three', ' four') }];

const agent = (id: string, body: string, extra: Partial<NoteMessage> = {}): NoteMessage => ({ id, body, author: { kind: 'agent' }, ...extra });
const review = (id: string): NoteMessage => ({ id, body: 'review', author: { kind: 'agent' }, guide: { review: true } });
const person = (id: string, body: string): NoteMessage => ({ id, body, author: { kind: 'person' } });

const notesOn = (messages: NoteMessage[], reviewId: string, files: NoteFile[], earlier: Record<string, NoteFile[]> = {}) =>
  threadNotes({ messages, reviewId, files, agent: () => 'Claude', round: (id) => messages.filter((m) => m.guide?.review).findIndex((m) => m.id === id) + 1, earlier: (id) => earlier[id] });

describe('the thread agent’s `:::note` blocks', () => {
  test('a note on this review lands on its lines, with what the person asked', () => {
    const messages = [review('r1'), person('q1', 'Why does this retry?\nmore'), agent('a1', 'Because.\n:::note a.ts#L2\nThe retry lives here.\n:::', { reply_to: 'q1' })];
    expect(notesOn(messages, 'r1', ROUND_1)).toEqual([
      { id: 't-a1-0', writer: 'thread', file: 'a.ts', side: 'new', lineStart: 2, lineEnd: 2, text: 'The retry lives here.', agent: 'Claude', message: 'a1', asked: 'Why does this retry?' },
    ]);
  });

  test('an Ask’s answer with no `:::note` block is never pinned, even when it answers lines', () => {
    const messages = [review('r1'), person('q1', 'a.ts lines 2–3: why this?'), agent('a1', 'Lines 2–3 of a.ts retry because the token can expire.', { reply_to: 'q1' })];
    expect(notesOn(messages, 'r1', ROUND_1)).toEqual([]);
  });

  test('a person’s `:::note` is not a note: only the agent writes them', () => {
    const messages = [review('r1'), { ...person('p1', ':::note a.ts#L2\nMine.\n:::') }];
    expect(notesOn(messages, 'r1', ROUND_1)).toEqual([]);
  });

  test('lines outside this review’s diff draw nothing', () => {
    const messages = [review('r1'), agent('a1', ':::note a.ts#L40-L42\nFar away.\n:::'), agent('a2', ':::note other.ts#L1\nNot in the diff.\n:::')];
    expect(notesOn(messages, 'r1', ROUND_1)).toEqual([]);
  });

  test('a note from an earlier round lands where its text is now, fresh', () => {
    const messages = [review('r1'), agent('a1', ':::note a.ts#L2\nThe retry.\n:::'), review('r2')];
    const [note] = notesOn(messages, 'r2', ROUND_2, { r1: ROUND_1 });
    expect([note?.lineStart, note?.lineEnd, note?.stale]).toEqual([4, 4, undefined]);
  });

  test('when the text changed, the note is stale, naming its round and its old lines', () => {
    const messages = [review('r1'), agent('a1', ':::note a.ts#L2\nThe retry.\n:::'), review('r2')];
    const [note] = notesOn(messages, 'r2', ROUND_3, { r1: ROUND_1 });
    expect(note?.stale).toEqual({ round: 1, lines: [2, 2] });
    expect(note?.lineStart).toBe(2);
    expect(staleWords(note!)).toBe('The code here changed after this answer (written on round 1, lines 2).');
  });

  test('an earlier round not read yet, and a later round’s notes, draw nothing', () => {
    const messages = [review('r1'), agent('a1', ':::note a.ts#L2\nThe retry.\n:::'), review('r2'), agent('a2', ':::note a.ts#L4\nLater.\n:::')];
    expect(notesOn(messages, 'r2', ROUND_2)).toEqual([expect.objectContaining({ id: 't-a2-0' })]);
    expect(notesOn(messages, 'r1', ROUND_1).map((n) => n.id)).toEqual(['t-a1-0']);
  });
});

describe('the other writers', () => {
  test('the guide author’s notes outside the diff are left out', () => {
    const snapshot = { guide: { title: 't', intent: 'i', sections: [{ title: 's', overview: 'o', diffs: [{ file: 'a.ts', notes: [{ lineStart: 2, lineEnd: 3, text: 'In.' }, { lineStart: 9, lineEnd: 9, text: 'Out.' }] }] }], reviewed: [false] } };
    expect(guideNotes(snapshot as never, ROUND_1, 'Claude').map((n) => n.text)).toEqual(['In.']);
  });

  test('only a high risk marks code, and only places in the diff', () => {
    const place = { file: 'a.ts', side: 'new' as const, lines: [2, 3] as [number, number], rule: 'Anything in auth.', why: 'Tokens now retry.' };
    const high: InboxPullRiskJudgment = { level: 'high', why: 'Auth.', where: [place, { ...place, lines: [30, 31] }] };
    expect(riskNotes(high, ROUND_1)).toEqual([{ id: 'r-0', writer: 'risk', file: 'a.ts', side: 'new', lineStart: 2, lineEnd: 3, text: 'Tokens now retry.', level: 'high', rule: 'Anything in auth.' }]);
    expect(riskNotes({ ...high, level: 'medium' }, ROUND_1)).toEqual([]);
    expect(riskNotes(null, ROUND_1)).toEqual([]);
  });

  test('a board’s parts on code: one note per part and place, none outside the diff', () => {
    const part = { board: 'b1', title: 'Flow', part: 'Retry', words: 'Retries once.', lines: [2, 2] as [number, number], path: 'a.ts', agent: 'Claude' };
    const notes = pictureNotes([part, part, { ...part, lines: [20, 21] }], ROUND_1);
    expect(notes.map((n) => [n.writer, n.lineStart, n.text, n.picture?.board])).toEqual([['picture', 2, 'Retries once.', 'b1']]);
  });

  test('a part drawn on an earlier round whose code changed is stale, in the picture’s words', () => {
    const part = { board: 'b1', title: 'Flow', part: 'Retry', words: 'Retries once.', lines: [2, 2] as [number, number], path: 'a.ts', agent: 'Claude', stale: { round: 1, lines: [2, 2] as [number, number] } };
    const [note] = pictureNotes([part], ROUND_3);
    expect(staleWords(note!)).toBe('The code here changed after this picture (drawn on round 1, lines 2).');
  });

  test('the PR page’s ask for the places is taken once, by that PR only', () => {
    askRiskPlaces('github.com/a/b#1');
    expect(takeRiskPlaces('github.com/a/b#1')).toBe(true);
    expect(takeRiskPlaces('github.com/a/b#1')).toBe(false);
  });

  test('an ask no diff took never moves a diff opened later: another PR’s diff drops it, and it runs out', () => {
    askRiskPlaces('github.com/a/b#1', 1_000);
    expect(takeRiskPlaces('github.com/a/b#2', 1_100)).toBe(false);
    expect(takeRiskPlaces('github.com/a/b#1', 1_200)).toBe(false);
    askRiskPlaces('github.com/a/b#1', 1_000);
    expect(takeRiskPlaces('github.com/a/b#1', 1_000 + RISK_PLACES_ASK_MS + 1)).toBe(false);
  });
});

describe('the thread’s chips', () => {
  test('a note before the thread’s first review is drawn on none: its chip has no review to open', () => {
    const messages: NoteMessage[] = [
      agent('a0', ':::note a.ts#L2\nEarly.\n:::', { created_at: '2026-11-07T10:00:00Z' }),
      { ...review('r1'), created_at: '2026-11-07T10:05:00Z' },
      agent('a1', ':::note a.ts#L2\nAfter.\n:::', { created_at: '2026-11-07T10:06:00Z' }),
      agent('a2', 'No note here.', { created_at: '2026-11-07T10:07:00Z' }),
    ];
    const reviews = noteReviews(messages);
    expect(reviews.get('a0')).toBeNull();
    expect(reviews.get('a1')).toBe('r1');
    expect(reviews.has('a2')).toBe(false);
    expect(noteReviews([agent('a0', ':::note a.ts#L2\nNo review yet.\n:::')]).size).toBe(0);
  });

  test('a removed-side place opens the removed-side note on those lines, never a new-side one on the same numbers', () => {
    const oldNote = { file: 'a.ts', side: 'old' as const, lineStart: 3, lineEnd: 4 };
    const newNote = { ...oldNote, side: 'new' as const };
    expect(noteHolds(oldNote, { path: 'a.ts', line: 3, side: 'old' })).toBe(true);
    expect(noteHolds(newNote, { path: 'a.ts', line: 3, side: 'old' })).toBe(false);
    expect(noteHolds(newNote, { path: 'a.ts', line: 4, side: 'new' })).toBe(true);
    expect(noteHolds(newNote, { path: 'a.ts', line: 5, side: 'new' })).toBe(false);
  });
});
