/**
 * The board's Table rules (tableModel.ts). What regresses:
 *  - the Table not coming back after a reload of `#prs&layout=table` (App reads `layout` off the address with
 *    `sheetLayoutOf` and writes it with `sheetLayoutHash`), or Grid writing a `layout` older addresses never had;
 *  - a sort splitting a stack's layers, or reordering them;
 *  - a header's second click not reversing, or a tie losing the board's order.
 */
import { describe, expect, test } from 'bun:test';
import { inboxPullStacks, type InboxPull } from '@plannotator/core/inbox-types';
import { nextSort, sheetLayoutHash, sheetLayoutOf, sortUnits } from './tableModel';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const pr = (number: number, over: Partial<InboxPull> = {}): InboxPull => ({
  key: `github.com/northwind/ledger#${number}`,
  platform: 'github',
  host: 'github.com',
  repo: 'northwind/ledger',
  number,
  url: `https://github.com/northwind/ledger/pull/${number}`,
  title: `Change ${number}`,
  author: 'kim',
  mine: false,
  requested: false,
  state: 'open',
  base: 'main',
  head: `b${number}`,
  head_repo: 'northwind/ledger',
  head_sha: 'a'.repeat(40),
  additions: 1,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: 'success',
  conflicts: false,
  updated_at: day(1),
  merged_at: null,
  ...over,
});

describe('the layout in the address', () => {
  test('an address written with Table reads back as Table, beside Merged', () => {
    const hash = `prs&state=merged${sheetLayoutHash('table')}`;
    const params = new URLSearchParams(hash);
    expect(sheetLayoutOf(params.get('layout'))).toBe('table');
    expect(params.get('state')).toBe('merged');
  });
  test('Grid writes nothing, and an address without layout, or with an unknown one, is the grid', () => {
    expect(sheetLayoutHash('grid')).toBe('');
    expect(sheetLayoutHash(undefined)).toBe('');
    expect(sheetLayoutOf(new URLSearchParams('prs').get('layout'))).toBe('grid');
    expect(sheetLayoutOf('tiles')).toBe('grid');
  });
});

describe('sorting the table', () => {
  // #10 under #11 (a stack, landing order 10 then 11), and two single PRs.
  const stackLow = pr(10, { title: 'Zebra', additions: 900 });
  const stackHigh = pr(11, { base: 'b10', title: 'Apple', additions: 1 });
  const small = pr(12, { title: 'Mango', additions: 5, updated_at: day(0.1) });
  const old = pr(13, { title: 'Kiwi', additions: 50, updated_at: day(9), checks: 'failure' });
  const units = inboxPullStacks([stackLow, stackHigh, small, old]);
  const order = (list: ReturnType<typeof sortUnits>) => list.flatMap((u) => u.layers.map((l) => l.number));

  test('a stack moves as one block, its layers in landing order, sorted by the layer that lands next', () => {
    // Title: the stack sorts by #10 ("Zebra"), so it goes last, #11 still right after #10.
    expect(order(sortUnits(units, { key: 'title', dir: 1 }, NOW))).toEqual([13, 12, 10, 11]);
    expect(order(sortUnits(units, { key: 'size', dir: 1 }, NOW))).toEqual([12, 13, 10, 11]);
  });

  test('the same header again reverses; a new header sorts its first way', () => {
    const first = nextSort(null, 'size');
    expect(first).toEqual({ key: 'size', dir: 1 });
    const again = nextSort(first, 'size');
    expect(order(sortUnits(units, again, NOW))).toEqual([10, 11, 13, 12]);
    expect(nextSort(again, 'title')).toEqual({ key: 'title', dir: 1 });
  });

  test('first clicks put what needs a look first: the newest update, failing checks', () => {
    expect(order(sortUnits(units, { key: 'updated', dir: 1 }, NOW))[0]).toBe(12);
    expect(order(sortUnits(units, { key: 'checks', dir: 1 }, NOW))[0]).toBe(13);
  });

  test('no sort, or a tie, keeps the board order', () => {
    expect(order(sortUnits(units, null, NOW))).toEqual(order(units));
    // Every author is kim: a tie all through.
    expect(order(sortUnits(units, { key: 'author', dir: 1 }, NOW))).toEqual(order(units));
    expect(order(sortUnits(units, { key: 'author', dir: -1 }, NOW))).toEqual(order(units));
  });
});
