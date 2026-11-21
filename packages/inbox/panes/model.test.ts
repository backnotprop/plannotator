/**
 * The thread panes' model (panes/model.ts): the verbs a second pane will use, and the rule that one thread shows in one
 * pane at most. What regresses: a thread drawn in two panes (two reply boxes writing one server draft), the main pane
 * closed (the address left with no pane), the active pane lost on a close, a no-op that returns a new set (every
 * slot drawn again for nothing).
 */
import { describe, expect, test } from 'bun:test';
import { MAIN_PANE, addressThread, close, closePane, focusPane, followAddress, move, open, paneOf, paneThread, singlePane, split, type PaneSet } from './model';

const ids = (set: PaneSet) => set.panes.map((pane) => `${pane.id}:${pane.thread ?? '-'}`);
const two = () => split(singlePane('t1'), MAIN_PANE, { id: 'p2', thread: 't2' }, 'right');

describe('open', () => {
  test('the active pane shows the thread; the same thread again changes nothing', () => {
    const set = open(singlePane(), 't1');
    expect(ids(set)).toEqual(['main:t1']);
    expect(open(set, 't1')).toBe(set);
    expect(ids(open(set, 't2'))).toEqual(['main:t2']);
    expect(ids(open(set, null))).toEqual(['main:-']);
  });

  test('a thread another pane shows focuses that pane instead of showing twice', () => {
    const set = focusPane(two(), MAIN_PANE);
    const next = open(set, 't2');
    expect(ids(next)).toEqual(['main:t1', 'p2:t2']);
    expect(next.active).toBe('p2');
  });

  test('a named pane, or a pane that is not there', () => {
    const set = two();
    expect(ids(open(set, 't3', MAIN_PANE))).toEqual(['main:t3', 'p2:t2']);
    expect(open(set, 't3', 'gone')).toBe(set);
  });
});

describe('split', () => {
  test('a pane beside the target, on either edge, becomes active', () => {
    const right = two();
    expect(ids(right)).toEqual(['main:t1', 'p2:t2']);
    expect(right.active).toBe('p2');
    const left = split(right, 'p2', { id: 'p3', thread: 't3' }, 'left');
    expect(ids(left)).toEqual(['main:t1', 'p3:t3', 'p2:t2']);
    expect(left.active).toBe('p3');
  });

  test('a taken id, a missing target or a thread already shown adds nothing', () => {
    const set = focusPane(two(), MAIN_PANE);
    expect(split(set, MAIN_PANE, { id: 'p2', thread: 't9' })).toBe(set);
    expect(split(set, 'gone', { id: 'p3', thread: 't9' })).toBe(set);
    const shown = split(set, MAIN_PANE, { id: 'p3', thread: 't2' });
    expect(ids(shown)).toEqual(['main:t1', 'p2:t2']);
    expect(shown.active).toBe('p2');
  });
});

describe('move', () => {
  test('a pane goes to an edge of another; threads and the active pane stay', () => {
    const set = split(two(), 'p2', { id: 'p3', thread: 't3' }, 'right');
    const moved = move(set, 'p3', MAIN_PANE, 'left');
    expect(ids(moved)).toEqual(['p3:t3', 'main:t1', 'p2:t2']);
    expect(moved.active).toBe(set.active);
    expect(move(set, 'p3', 'p2', 'right')).toBe(set);
    expect(move(set, 'p3', 'p3', 'left')).toBe(set);
    expect(move(set, 'gone', 'p2', 'left')).toBe(set);
  });
});

describe('close', () => {
  test('the active pane closing hands active to its left neighbour, or the right one when it was first', () => {
    const three = split(two(), 'p2', { id: 'p3', thread: 't3' }, 'right');
    const closed = close(three, 'p3');
    expect(ids(closed)).toEqual(['main:t1', 'p2:t2']);
    expect(closed.active).toBe('p2');
    const first = close(focusPane(move(three, 'p3', MAIN_PANE, 'left'), 'p3'), 'p3');
    expect(first.active).toBe(MAIN_PANE);
  });

  test('another pane closing keeps the active one', () => {
    const set = focusPane(two(), MAIN_PANE);
    expect(close(set, 'p2')).toEqual({ panes: [{ id: MAIN_PANE, thread: 't1' }], active: MAIN_PANE });
  });

  test('the main pane only empties, so the address always has its pane', () => {
    const set = close(two(), MAIN_PANE);
    expect(ids(set)).toEqual(['main:-', 'p2:t2']);
    expect(close(singlePane(), MAIN_PANE)).toEqual(singlePane());
    expect(close(two(), 'gone').panes).toHaveLength(2);
  });
});

describe('the address names the active pane\'s thread', () => {
  test('a link to a thread another pane shows focuses that pane; the address and the panes then agree', () => {
    const set = focusPane(two(), MAIN_PANE);
    const next = followAddress(set, 't2');
    expect(ids(next)).toEqual(['main:t1', 'p2:t2']);
    expect(next.active).toBe('p2');
    expect(addressThread(next)).toBe('t2');
  });

  test('any other thread shows in the active pane, whichever it is; the others keep theirs', () => {
    const fromSecond = followAddress(two(), 't3');
    expect(ids(fromSecond)).toEqual(['main:t1', 'p2:t3']);
    expect(addressThread(fromSecond)).toBe('t3');
    const fromMain = followAddress(focusPane(two(), MAIN_PANE), null);
    expect(ids(fromMain)).toEqual(['main:-', 'p2:t2']);
    expect(addressThread(fromMain)).toBeNull();
  });

  test('focusing a pane changes the thread the address names; the address already named changes nothing', () => {
    const set = two();
    expect(addressThread(set)).toBe('t2');
    expect(addressThread(focusPane(set, MAIN_PANE))).toBe('t1');
    expect(followAddress(set, 't2')).toBe(set);
  });
});

describe('focusPane and lookups', () => {
  test('focus moves active only to a pane that exists; lookups by id and by thread', () => {
    const set = two();
    expect(focusPane(set, 'p2')).toBe(set);
    expect(focusPane(set, 'gone')).toBe(set);
    expect(focusPane(set, MAIN_PANE).active).toBe(MAIN_PANE);
    expect(paneThread(set, 'p2')).toBe('t2');
    expect(paneThread(set, 'gone')).toBeNull();
    expect(paneOf(set, 't1')).toBe(MAIN_PANE);
    expect(paneOf(set, 't9')).toBeNull();
  });
});

describe('closePane: the person closes a pane', () => {
  test("beside another, the main pane takes the other's thread, so one pane left is the main pane; alone it only empties", () => {
    expect(ids(closePane(two(), MAIN_PANE))).toEqual(['main:t2']);
    expect(closePane(two(), MAIN_PANE).active).toBe(MAIN_PANE);
    expect(ids(closePane(two(), 'p2'))).toEqual(['main:t1']);
    expect(closePane(two(), 'p2').active).toBe(MAIN_PANE);
    expect(ids(closePane(singlePane('t1'), MAIN_PANE))).toEqual(['main:-']);
  });
});
