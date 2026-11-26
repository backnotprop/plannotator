/**
 * Where an earlier round's lines are in this round's diff (core `line-anchor`), the rule a context note written on an
 * earlier review lands by. What regresses if these fail: a note lands on lines that hold other code now, or loses
 * lines that only moved.
 */
import { describe, expect, test } from 'bun:test';
import { anchorLines, earlierLinesNow, shiftLines } from '@plannotator/core/line-anchor';

describe("an earlier round's lines in this round", () => {
  test("lines where they are now: moved, they follow; changed or unseen, none", () => {
    const before = new Map([[16, 'a'], [17, 'b'], [18, 'c']]);
    expect(anchorLines([16, 18], before, new Map([[17, 'a'], [18, 'b'], [19, 'c']]))).toEqual([17, 19]);
    expect(anchorLines([16, 18], before, new Map([[16, 'a'], [17, 'B'], [18, 'c']]))).toBeNull();
    expect(anchorLines([15, 16], before, new Map([[15, 'z'], [16, 'a']]))).toBeNull();
  });

  test("an earlier round's changed lines are found where the code around them moved, never at their old numbers (the delta-5 repro)", () => {
    // Round 1: lines 1–100. Round 2: 30 lines added above, and old line 51 edited.
    const round1 = new Map(Array.from({ length: 100 }, (_, i) => [i + 1, `line ${i + 1}`] as const));
    const round2 = new Map<number, string>();
    for (let i = 1; i <= 30; i++) round2.set(i, `added ${i}`);
    for (let i = 1; i <= 100; i++) round2.set(i + 30, i === 51 ? 'line 51, edited' : `line ${i}`);
    expect(anchorLines([50, 52], round1, round2)).toBeNull();
    expect(shiftLines([50, 52], round1, round2)).toEqual([80, 82]);
    const now = earlierLinesNow([50, 52], round1, round2)!;
    expect(now).toEqual([80, 82]);
    // Unchanged lines that moved are followed as before; with nothing to go by (the earlier diff unread), no place.
    expect(earlierLinesNow([10, 12], round1, round2)).toEqual([40, 42]);
    expect(earlierLinesNow([50, 52], undefined, round2)).toBeNull();
    // A line that moved past the others is no guide: the offset comes from the lines kept in order.
    const swapped = new Map(round2);
    swapped.set(1, 'line 49');
    swapped.set(79, 'added 1');
    expect(shiftLines([50, 52], round1, swapped)).toEqual([80, 82]);
  });

  test("an earlier round's lines are not placed on other code: a deleted block, a line added beside it, a repeated line (the delta-6 repros)", () => {
    const round1 = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, `line ${i + 1}`] as const));
    const round2 = (...texts: string[]) => new Map(texts.map((text, i) => [i + 1, text] as const));
    const rest = (from: number) => Array.from({ length: 11 - from }, (_, i) => `line ${from + i}`);
    // (a) Lines 4–6 deleted, the line above kept: 4–6 is other code now.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', ...rest(7)))).toBeNull();
    // (b) A line added between the guide and the block, line 5 edited: the block is at 5–7.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'added', 'line 4', 'line 5, edited', 'line 6', ...rest(7)))).toEqual([5, 7]);
    // The same with every line of the block edited: the added line may be part of it or not, so no place.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'added', 'edited 4', 'edited 5', 'edited 6', ...rest(7)))).toBeNull();
    // A line added inside the block, its ends kept (the fix inside what the note named): the block grew.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'line 4', 'added', 'line 5, edited', 'line 6', ...rest(7)))).toEqual([4, 7]);
    // Edited in place, the lines around it kept: the same numbers.
    expect(earlierLinesNow([4, 6], round1, round2('line 1', 'line 2', 'line 3', 'edited 4', 'edited 5', 'edited 6', ...rest(7)))).toEqual([4, 6]);
    // (c) `return null;` and `}` are shown once in each diff, but in other functions: the block is gone, nothing below agrees.
    const before = new Map([[197, 'function kept() {'], [198, '  return null;'], [199, '}'], [200, 'function gone() {'], [201, '  work();'], [202, '  done();'], [203, 'export default gone;']]);
    const after = new Map([[196, 'const a = 1;'], [197, 'function other() {'], [198, '  if (x) foo();'], [199, '  return null;'], [200, '}'], [201, ''], [202, 'const b = 2;']]);
    expect(earlierLinesNow([200, 202], before, after)).toBeNull();
  });
});
