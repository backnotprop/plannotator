/**
 * A linked computer's canvas saves (farSave.ts, used by CanvasBoard.tsx). What regresses: drawing for minutes while
 * that computer is away queuing one outbox entry per pause (a save names again what a held save already carries); a
 * new picture whose file cannot go yet stopping every later change from being saved; a save past the outbox's bound
 * refused for ever instead of going in parts; a held save that was refused, or whose link went, said in neutral words
 * or not at all; each short pause while a save is held rewriting the whole entry on disk; a held Undo said in fixed
 * words that do not follow that computer, or cleared by a press on the canvas while it still waits.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { heldWords, type OutboxView } from '../api';
import { boardLine, FAR_PART_CHARS, farChanges, farParts, HELD_SAVE_AFTER_MS, heldEnd, joinHeld, SAVE_AFTER_MS, saveTimer, type HeldSave } from './farSave';

type El = { id: string; type?: string; version: number; isDeleted?: boolean; fileId?: string; points?: number[][] };
const sig = (el: El) => `${el.version}:${el.isDeleted ? 1 : 0}`;
const box = (id: string, version = 1): El => ({ id, type: 'rectangle', version });

describe('what a far save names', () => {
  test('a change a held save carries as it is now is not named again; a later change of the same thing is', () => {
    const synced = new Map([['a', '1:0']]);
    const held: HeldSave[] = [{ sent: new Map([['b', '1:0'], ['c', '1:0']]), gone: [] }];
    // The person drew b and c (held), then moved c again and drew d.
    const change = farChanges([box('a'), box('b'), box('c', 2), box('d')], synced, held, new Set(), sig);
    expect(change.elements.map((e) => e.id)).toEqual(['c', 'd']);
    // Nothing new since the held save: nothing to send (the tab put away again sends no second entry).
    expect(farChanges([box('a'), box('b'), box('c')], synced, held, new Set(), sig).elements).toEqual([]);
  });

  test('a picture whose file waits for that computer is held back; every other change still goes', () => {
    const picture: El = { id: 'p', type: 'image', version: 3, fileId: 'file_1' };
    const change = farChanges([picture, box('a', 2)], new Map([['a', '1:0']]), [], new Set(['file_1']), sig);
    expect(change.elements.map((e) => e.id)).toEqual(['a']);
    expect(change.pictures).toBe(1);
    // Once its file went, the picture goes.
    expect(farChanges([picture], new Map(), [], new Set(), sig).elements.map((e) => e.id)).toEqual(['p']);
  });

  test('what the editor no longer holds is removed once: not again while a held save removes it', () => {
    const synced = new Map([['a', '1:0'], ['gone_1', '1:0'], ['gone_2', '1:0']]);
    expect(farChanges([box('a')], synced, [{ sent: new Map(), gone: ['gone_1'] }], new Set(), sig).gone).toEqual(['gone_2']);
  });
});

describe('a far save in parts', () => {
  test('each part stays under the bound, in order, and nothing is lost; one thing larger than the bound is a part of its own', () => {
    const stroke = (id: string, n: number): El => ({ id, type: 'freedraw', version: 1, points: Array.from({ length: n }, (_, i) => [i * 1.123456789, i * 2.987654321]) });
    const elements = [stroke('s1', 2000), stroke('s2', 2000), stroke('s3', 2000), stroke('huge', 12_000), box('after')];
    const parts = farParts(elements, ['gone_1']);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((p) => p.elements.map((e) => e.id))).toEqual(['s1', 's2', 's3', 'huge', 'after']);
    expect(parts.flatMap((p) => p.gone)).toEqual(['gone_1']);
    for (const part of parts) if (!part.elements.some((e) => e.id === 'huge')) expect(JSON.stringify(part).length).toBeLessThan(FAR_PART_CHARS + 1000);
    expect(parts.find((p) => p.elements.some((e) => e.id === 'huge'))!.elements.map((e) => e.id)).toEqual(['huge']);
    expect(farParts([], [])).toEqual([]);
  });
});

describe('how a held save ended', () => {
  const entry = (over: Partial<OutboxView>): OutboxView => ({ key: 'k', machine: 'ibx_1', route: 'threads/msg_1/canvas', state: 'queued', queued_at: '2026-11-25T08:00:00Z', settled_at: null, status: null, answer: null, notice: null, dismissed: false, ...over });
  const macbook = { name: 'MacBook', state: 'offline' as const };

  test('waiting is no end; delivered landed; refused, unlinked and given up each say why', () => {
    expect(heldEnd(undefined, macbook)).toBeNull();
    expect(heldEnd(entry({ state: 'sending' }), macbook)).toBeNull();
    expect(heldEnd(entry({ state: 'delivered', status: 200, answer: { rev: 4 } }), macbook)).toEqual({ landed: true });
    const at = '2026-11-25T08:05:00Z';
    expect(heldEnd(entry({ state: 'refused', status: 409, answer: { error: 'The canvas is off in this Inbox.' }, notice: { kind: 'refused', at } }), macbook)).toEqual({ landed: false, words: 'Not delivered: The canvas is off in this Inbox.' });
    // The link went: the window no longer knows the machine, the entry keeps its name.
    expect(heldEnd(entry({ state: 'dropped', notice: { kind: 'not_delivered', at }, machine_name: 'MacBook' }), null)).toEqual({ landed: false, words: 'Not delivered: MacBook was unlinked before it went.' });
    expect(heldEnd(entry({ state: 'parked', notice: { kind: 'may_have_been_delivered', at } }), macbook)).toEqual({ landed: false, words: 'May have been delivered. Check on MacBook.' });
  });
});

describe('a save folded into the one that waits', () => {
  test('the entry carries both: the newer of each element, and what either removes that neither names again', () => {
    const first: HeldSave = { sent: new Map([['a', '1:0'], ['b', '1:0']]), gone: ['old_1', 'c'] };
    const joined = joinHeld(first, { sent: new Map([['b', '2:0'], ['c', '1:0']]), gone: ['old_2'] });
    expect([...joined.sent]).toEqual([['a', '1:0'], ['b', '2:0'], ['c', '1:0']]);
    expect(joined.gone).toEqual(['old_1', 'old_2']);
    expect(joinHeld(undefined, first)).toBe(first);
  });

  test('one the window\'s outbox listed and lists no more (read again after a reconnect) has ended; one not listed yet still waits', () => {
    expect(heldEnd(undefined, { name: 'MacBook', state: 'online' }, true)).toEqual({ landed: false, unknown: true });
    expect(heldEnd(undefined, { name: 'MacBook', state: 'online' }, false)).toBeNull();
  });
});

describe('the pause before a save', () => {
  afterEach(() => jest.useRealTimers());

  test('while a save waits for that computer each change is saved after a longer pause; stop cancels one that waited', () => {
    jest.useFakeTimers();
    let held = false;
    let saves = 0;
    const timer = saveTimer(() => saves++, () => held);
    timer.soon();
    jest.advanceTimersByTime(SAVE_AFTER_MS);
    expect(saves).toBe(1);
    // A save is held: the next pause is longer, and a change within it starts it again.
    held = true;
    timer.soon();
    jest.advanceTimersByTime(SAVE_AFTER_MS);
    expect(saves).toBe(1);
    timer.soon();
    jest.advanceTimersByTime(HELD_SAVE_AFTER_MS - 1);
    expect(saves).toBe(1);
    jest.advanceTimersByTime(1);
    expect(saves).toBe(2);
    // Put away, Send or Undo: the board stops the pause and saves at once.
    timer.soon();
    expect(timer.stop()).toBe(true);
    jest.advanceTimersByTime(HELD_SAVE_AFTER_MS);
    expect([saves, timer.stop()]).toEqual([2, false]);
  });
});

describe('the board\'s line for what waits for that computer', () => {
  test('a held Undo says what a held save says, following that computer, and a notice cleared does not take it', () => {
    const away = { name: 'MacBook', state: 'offline' as const };
    const back = { name: 'MacBook', state: 'online' as const };
    expect(boardLine(false, null, null, 'held words', away)).toEqual({ text: heldWords(away), held: true });
    expect(boardLine(false, null, null, 'held words', back)).toEqual({ text: heldWords(back), held: true });
    expect(boardLine(false, null, { held: 'save words' }, null, back)).toEqual(boardLine(false, null, null, 'undo words', back));
    // Without the machine: the outbox's own words.
    expect(boardLine(false, null, null, 'held words', null)).toEqual({ text: 'held words', held: true });
    // Something said once shows over it, and once it goes the held Undo shows again.
    expect(boardLine(false, { text: 'Sending…' }, null, 'held words', away)).toEqual({ text: 'Sending…' });
    expect(boardLine(false, null, null, null, away)).toBeNull();
  });
});
