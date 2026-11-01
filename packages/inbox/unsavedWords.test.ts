import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetWords, keepWords, keptWords } from './unsavedWords';

const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let held: Map<string, string>;

beforeEach(() => {
  held = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => void held.set(k, v), removeItem: (k: string) => void held.delete(k) },
  });
});

afterEach(() => {
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('unsavedWords', () => {
  test('words and the draft they were typed over come back after a reload', () => {
    keepWords('t1', 'hello', 'draft-at-1', 1000);
    expect(keptWords('t1', 2000)).toEqual({ text: 'hello', base: 'draft-at-1', at: 1000 });
  });

  test('a save answered for older words leaves the words typed since', () => {
    keepWords('t1', 'hello', null, 1000);
    keepWords('t1', 'hello there', null, 1100);
    forgetWords('t1', 'hello', 1200);
    expect(keptWords('t1', 1300)?.text).toBe('hello there');
    forgetWords('t1', 'hello there', 1400);
    expect(keptWords('t1', 1500)).toBeNull();
  });

  test('an emptied box is nothing to bring back', () => {
    keepWords('t1', 'hello', null, 1000);
    keepWords('t1', '  ', null, 1100);
    expect(keptWords('t1', 1200)).toBeNull();
  });

  test('words a day old are not brought back', () => {
    keepWords('t1', 'hello', null, 0);
    expect(keptWords('t1', 24 * 60 * 60_000)).toBeNull();
  });
});
