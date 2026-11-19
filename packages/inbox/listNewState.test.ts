/**
 * The list's two signs of news (listNewState.ts; the owner, 2026-11-17): the "N new · Show" bar while threads are
 * held, and the floating "New" button only after Show, for rows that landed out of view. If held news ever made the
 * button, the reader would follow it to rows that are not on the list yet.
 */
import { describe, expect, test } from 'bun:test';
import { listNewState } from './listNewState';
import type { UnseenRow } from './showLight';

const below = (id: string): UnseenRow => ({ id, edge: 'bottom' });
const above = (id: string): UnseenRow => ({ id, edge: 'top' });

describe('listNewState', () => {
  test('nothing held, nothing shown: no bar, no button', () => {
    expect(listNewState({ held: 0, unseen: [], watching: true })).toEqual({ bar: false, button: null });
  });

  test('held threads show the bar and never the button, however many', () => {
    for (const held of [1, 2, 40]) expect(listNewState({ held, unseen: [], watching: true })).toEqual({ bar: true, button: null });
  });

  test('after Show, rows that landed below the view show the button pointing down; the bar is gone', () => {
    expect(listNewState({ held: 0, unseen: [below('a'), below('b')], watching: true })).toEqual({ bar: false, button: { count: 2, edge: 'bottom' } });
  });

  test('rows that landed above point up', () => {
    expect(listNewState({ held: 0, unseen: [above('a')], watching: true })).toEqual({ bar: false, button: { count: 1, edge: 'top' } });
  });

  test('one side at a time: the side with more rows, below on a tie, never one mixed count', () => {
    expect(listNewState({ held: 0, unseen: [above('a'), above('b'), below('c')], watching: true }).button).toEqual({ count: 2, edge: 'top' });
    expect(listNewState({ held: 0, unseen: [above('a'), below('b'), below('c')], watching: true }).button).toEqual({ count: 2, edge: 'bottom' });
    expect(listNewState({ held: 0, unseen: [above('a'), below('b')], watching: true }).button).toEqual({ count: 1, edge: 'bottom' });
  });

  test('once the rows are seen (in view, or gone to), the button goes', () => {
    expect(listNewState({ held: 0, unseen: [], watching: true }).button).toBeNull();
  });

  test('rows the reader already had a sign of are not counted again', () => {
    expect(listNewState({ held: 0, unseen: [below('a'), below('b')], dismissed: new Set(['a']), watching: true }).button).toEqual({ count: 1, edge: 'bottom' });
    expect(listNewState({ held: 0, unseen: [below('a')], dismissed: new Set(['a']), watching: true }).button).toBeNull();
  });

  test('more news held after a Show: the bar for the held, the button still only for the shown rows out of view', () => {
    expect(listNewState({ held: 3, unseen: [below('a')], watching: true })).toEqual({ bar: true, button: { count: 1, edge: 'bottom' } });
  });

  test('a covered list or a hidden tab: the button waits; the bar is the held count alone', () => {
    expect(listNewState({ held: 2, unseen: [below('a')], watching: false })).toEqual({ bar: true, button: null });
  });
});
