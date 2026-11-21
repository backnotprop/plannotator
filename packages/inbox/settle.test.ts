/**
 * The settle's plan (settle.ts): which rows slide, fade in or fade out when
 * the list on screen catches up, and where focus goes when its row left.
 * What this catches: a row redrawn at another width stretched by a FLIP, rows
 * nobody can see animated (cost with no benefit), a row that did not move
 * animated anyway, and focus handed to the wrong neighbour (or to nobody).
 */
import { describe, expect, test } from 'bun:test';
import { planSettle, rowInSlot, type Box } from './settle';

const box = (top: number, width = 600, height = 50, left = 0): Box => ({ top, left, width, height });
const viewport = { top: 0, bottom: 500 };

describe('planSettle', () => {
  test('a row that moved slides from where it was; one that stayed does not', () => {
    const before = new Map([['row:a', box(0)], ['row:b', box(50)], ['row:c', box(100)]]);
    const after = new Map([['row:b', box(0)], ['row:c', box(100)], ['row:a', box(150)]]);
    expect(planSettle(before, after, viewport)).toEqual({ moves: [{ key: 'row:b', dx: 0, dy: 50 }, { key: 'row:a', dx: 0, dy: -150 }], enters: [], leaves: [] });
  });

  test('a row that left fades where it was; one that joined fades in; both only where they can be seen', () => {
    const before = new Map([['row:gone', box(10)], ['row:offscreen', box(900)]]);
    const after = new Map([['row:new', box(10)], ['row:late', box(800)]]);
    expect(planSettle(before, after, viewport)).toEqual({ moves: [], enters: ['row:new'], leaves: ['row:gone'] });
  });

  test('a row redrawn at another width, and a row out of sight before and after, are left alone', () => {
    const before = new Map([['row:wide', box(0, 900)], ['row:far', box(700)], ['row:in', box(700)]]);
    const after = new Map([['row:wide', box(50, 380)], ['row:far', box(900)], ['row:in', box(450)]]);
    expect(planSettle(before, after, viewport).moves).toEqual([{ key: 'row:in', dx: 0, dy: 250 }]);
  });
});

describe('rowInSlot', () => {
  const present = (ids: string[]) => (id: string) => ids.includes(id);
  test('the row that now sits where the gone one was: the next on screen, else the one before, else none', () => {
    expect(rowInSlot(['a', 'b', 'c', 'd'], 'b', present(['a', 'd']))).toBe('d');
    expect(rowInSlot(['a', 'b'], 'b', present(['a']))).toBe('a');
    expect(rowInSlot(['b'], 'b', present([]))).toBeNull();
    expect(rowInSlot(['a'], 'x', present(['a']))).toBeNull();
  });
});
