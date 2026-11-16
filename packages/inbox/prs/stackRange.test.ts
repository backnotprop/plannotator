/**
 * "Layers i–j" (stackRange.ts): which two layers make a range, what a range opens, its name, how an address's range is
 * checked against the list now, and the picks while choosing one. What regresses: a sibling branch's layer joining a
 * range (its compare would read a branch the range is not on), a range of one or one from the bottom opening a third
 * view of what This layer or Whole stack already shows, numbers that are not the stack page's own, and a stale
 * address reading a range whose layers merged.
 */
import { describe, expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull } from '@plannotator/core/inbox-types';
import { liveView, pickNext, rangeName, rangeOf, rangeOpens } from './stackRange';

const pr = (number: number, head: string, base: string, over: Partial<InboxPull> = {}): InboxPull => ({
  key: `github.com/northwind/ledger#${number}`,
  platform: 'github',
  host: 'github.com',
  repo: 'northwind/ledger',
  number,
  url: `https://github.com/northwind/ledger/pull/${number}`,
  title: `Change ${number}`,
  author: 'kim',
  mine: true,
  requested: false,
  state: 'open',
  base,
  head,
  head_repo: 'northwind/ledger',
  head_sha: String(number).padStart(40, 'a'),
  additions: 1,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  conflicts: false,
  updated_at: '2026-11-09T10:00:00Z',
  merged_at: null,
  ...over,
});

// main ← #1 (merged) ← #2 ← #3 ← #4 ← #5, and #6 a sibling of #4 on #3.
const merged = pr(1, 'one', 'main', { state: 'merged', merged_at: '2026-11-08T10:00:00Z' });
const stack = inboxPullStacks([merged, pr(2, 'two', 'one'), pr(3, 'three', 'two'), pr(4, 'four', 'three'), pr(5, 'five', 'four'), pr(6, 'six', 'three')])[0]!;
const key = (n: number) => `github.com/northwind/ledger#${n}`;

describe('a range', () => {
  test('is two open layers on one line, bottom first whichever is picked first, the layers between included', () => {
    const range = rangeOf(stack, key(5), key(3))!;
    expect(range.first.number).toBe(3);
    expect(range.last.number).toBe(5);
    expect(range.layers.map((l) => l.number)).toEqual([3, 4, 5]);
  });

  test("a sibling branch's layer is never in one, nor a merged layer at an end", () => {
    expect(rangeOf(stack, key(4), key(6))).toBeNull();
    expect(rangeOf(stack, key(5), key(6))).toBeNull();
    expect(rangeOf(stack, key(1), key(4))).toBeNull();
  });

  test("is named with the stack page's numbers: bottom first, merged layers counted, a sibling where the page puts it", () => {
    const line = inboxPullStacks([merged, pr(2, 'two', 'one'), pr(3, 'three', 'two'), pr(4, 'four', 'three'), pr(5, 'five', 'four')])[0]!;
    expect(rangeName(line, rangeOf(line, key(3), key(5))!)).toBe('Layers 3–5');
    // The page lists #6 (on #3) after #4, so #5 is its 6th row.
    expect(stack.layers.map((l) => l.number)).toEqual([1, 2, 3, 4, 6, 5]);
    expect(rangeName(stack, rangeOf(stack, key(3), key(5))!)).toBe('Layers 3–6');
  });
});

describe('what a range opens', () => {
  test('a range of one is that layer', () => {
    expect(rangeOpens(stack, rangeOf(stack, key(4), key(4))!)).toEqual({ layer: key(4), scope: 'layer' });
  });

  test('from the lowest open layer it is Whole stack up to its top', () => {
    expect(rangeOpens(stack, rangeOf(stack, key(2), key(4))!)).toEqual({ layer: key(4), scope: 'stack' });
  });

  test('else the range, on its top layer, from its lowest', () => {
    expect(rangeOpens(stack, rangeOf(stack, key(3), key(5))!)).toEqual({ layer: key(5), scope: `range:${key(3)}` });
  });
});

describe("an address's range, checked against the list now", () => {
  test('stays a range while its layers are one open line', () => {
    expect(liveView(stack, key(5), `range:${key(3)}`)).toBe(`range:${key(3)}`);
  });

  test('is the layer once its lowest layer merged or left its line', () => {
    const later = inboxPullStacks([merged, pr(2, 'two', 'one'), pr(3, 'three', 'two', { state: 'merged' }), pr(4, 'four', 'three'), pr(5, 'five', 'four')])[0]!;
    expect(liveView(later, key(5), `range:${key(3)}`)).toBe('layer');
    expect(liveView(stack, key(6), `range:${key(4)}`)).toBe('layer');
  });

  test('is Whole stack once the layers under it landed', () => {
    const landed = inboxPullStacks([pr(2, 'two', 'one', { state: 'merged' }), pr(3, 'three', 'two'), pr(4, 'four', 'three'), pr(5, 'five', 'four')])[0]!;
    expect(liveView(landed, key(5), `range:${key(3)}`)).toBe('stack');
  });

  test('other views pass through', () => {
    expect(liveView(stack, key(5), 'stack')).toBe('stack');
    expect(liveView(stack, key(5), `since:${'b'.repeat(40)}`)).toBe(`since:${'b'.repeat(40)}`);
  });
});

describe('picking the ends', () => {
  test('one end, then the other; the same one again lets it go; a third starts again', () => {
    expect(pickNext(stack, [], key(3))).toEqual([key(3)]);
    expect(pickNext(stack, [key(3)], key(5))).toEqual([key(3), key(5)]);
    expect(pickNext(stack, [key(3)], key(3))).toEqual([]);
    expect(pickNext(stack, [key(3), key(5)], key(2))).toEqual([key(2)]);
  });

  test("an end on a sibling branch starts again from it; a merged layer can't be picked", () => {
    expect(pickNext(stack, [key(4)], key(6))).toEqual([key(6)]);
    expect(pickNext(stack, [key(3)], key(1))).toEqual([key(3)]);
  });
});
