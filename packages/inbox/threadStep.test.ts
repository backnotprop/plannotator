import { describe, expect, test } from 'bun:test';
import { askArrivalFocus, takeArrivalFocus, threadStep } from './threadStep';

describe('next and previous thread (J / K)', () => {
  const order = ['a', 'b', 'c'];

  test('follows the list order both ways', () => {
    expect(threadStep(order, 'b', 1)).toEqual({ to: 'c' });
    expect(threadStep(order, 'b', -1)).toEqual({ to: 'a' });
  });

  test('stops at the ends, never wraps', () => {
    expect(threadStep(order, 'c', 1)).toEqual({ end: 'last' });
    expect(threadStep(order, 'a', -1)).toEqual({ end: 'first' });
  });

  test('a thread not in the list on screen (folded in Quiet) goes nowhere', () => {
    expect(threadStep(order, 'quiet-one', 1)).toBeNull();
  });

  test('an open thread that left the rows on screen steps from the slot it had', () => {
    const before = ['a', 'b', 'c', 'd'];
    expect(threadStep(['a', 'c', 'd'], 'b', 1, before)).toEqual({ to: 'c' });
    expect(threadStep(['a', 'c', 'd'], 'b', -1, before)).toEqual({ to: 'a' });
    expect(threadStep(['a', 'd'], 'b', 1, before)).toEqual({ to: 'd' });
    expect(threadStep(['c', 'd'], 'b', -1, before)).toEqual({ end: 'first' });
    expect(threadStep(['a'], 'b', 1, before)).toEqual({ end: 'last' });
    expect(threadStep(['a', 'c'], 'x', 1, before)).toBeNull();
  });

  test('the focus asked for goes to that thread once, and to no other', () => {
    askArrivalFocus('b');
    expect(takeArrivalFocus('c')).toBe(false);
    expect(takeArrivalFocus('b')).toBe(true);
    expect(takeArrivalFocus('b')).toBe(false);
  });
});
