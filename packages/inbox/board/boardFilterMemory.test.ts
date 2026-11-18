/**
 * The Board's remembered filter (boardFilterMemory.ts): what the Board last showed is what its sidebar row opens.
 *
 * What this catches: a cleared filter that still opens filtered (the cookie kept); a cookie that breaks the Board or
 * puts anything but an id into its address; a page with no cookies that throws.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import { BOARD_FILTER_COOKIE, rememberBoardFilter, rememberedBoardFilter } from './boardFilterMemory';

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
});
afterEach(() => resetStorageBackend());

test('the last filter shown opens next time; nothing shown removes the cookie', () => {
  expect(rememberedBoardFilter()).toEqual({ project: null, initiative: null });
  rememberBoardFilter({ project: null, initiative: 'ini_work' });
  expect(rememberedBoardFilter()).toEqual({ project: null, initiative: 'ini_work' });
  rememberBoardFilter({ project: 'prj_bill', initiative: 'none' });
  expect(rememberedBoardFilter()).toEqual({ project: 'prj_bill', initiative: 'none' });
  rememberBoardFilter({ project: null, initiative: null });
  expect(stored.has(BOARD_FILTER_COOKIE)).toBe(false);
});

test('a cookie it cannot read, or that names anything but an id, is no filter', () => {
  stored.set(BOARD_FILTER_COOKIE, '{ nope');
  expect(rememberedBoardFilter()).toEqual({ project: null, initiative: null });
  stored.set(BOARD_FILTER_COOKIE, JSON.stringify({ project: 'prj_a&card=crd_x', initiative: 42 }));
  expect(rememberedBoardFilter()).toEqual({ project: null, initiative: null });
});

test('a page with no cookies opens every card and never throws', () => {
  setStorageBackend({
    getItem: () => {
      throw new Error('no cookies');
    },
    setItem: () => {
      throw new Error('no cookies');
    },
    removeItem: () => {
      throw new Error('no cookies');
    },
  });
  expect(() => rememberBoardFilter({ project: 'prj_a', initiative: null })).not.toThrow();
  expect(rememberedBoardFilter()).toEqual({ project: null, initiative: null });
});
