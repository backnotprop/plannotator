/**
 * The files panel's refresh order (relist.ts): what the server's 25,000-row cap refused last time is asked for first
 * next time, so with more rows open than one answer holds, every folder still gets listed in turn.
 */
import { describe, expect, test } from 'bun:test';
import { relistOrder } from './relist';

describe('relistOrder', () => {
  test('the root first, then the folders refused last time, then the rest in their order', () => {
    expect(relistOrder(['a', 'b', 'c', 'd'], new Set(['c', 'd']))).toEqual(['', 'c', 'd', 'a', 'b']);
  });

  test('nothing refused: the open folders in their order, the root once', () => {
    expect(relistOrder(['', 'a', 'b'], new Set())).toEqual(['', 'a', 'b']);
  });

  test('a cap that refuses the tail every time still reaches every folder (the server lists in order until full)', () => {
    const open = ['a', 'b', 'c', 'd', 'e', 'f'];
    // A stand-in for the server: three folders fit in one answer; the rest are refused.
    const answer = (dirs: string[]) => ({ listed: dirs.filter((d) => d !== '').slice(0, 3), refused: dirs.filter((d) => d !== '').slice(3) });
    let starved: ReadonlySet<string> = new Set();
    const seen = new Set<string>();
    for (let refresh = 0; refresh < 2; refresh++) {
      const got = answer(relistOrder(open, starved));
      for (const dir of got.listed) seen.add(dir);
      starved = new Set(got.refused);
    }
    expect([...seen].sort()).toEqual(open);
  });
});
