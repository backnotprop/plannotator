/**
 * The whole pane area's outer edges (outerEdge.ts, layoutModel.ts `WHOLE`): where a drop there puts the new pane in
 * the tree, and whether it fits the room with every pane at 400 x 260 px (layoutModel.ts `PANE_MIN_WIDTH`, `PANE_MIN_HEIGHT`) and none stepping aside.
 *
 * What regresses: a rim drop splitting one pane instead of spanning the area; the new column taking half the room
 * instead of one column's share; "fits" said where a pane would step aside (or fall below its minimum), or refused
 * where it fits; a pane already on that whole side moving anyway; the strip not winning near the rim, or reaching
 * into a pane's own edge zone.
 *
 * The rooms are the ones measured in the sandbox (Playwright, the owner's five panes, sidebar folded for room as
 * the drop does): 1440 x 900 gives 1036 x 884 beside the list, 1728 x 1117 gives 1324 x 1101, 1920 x 1080 gives
 * 1516 x 1064; the gap is 8 px.
 */
import { describe, expect, test } from 'bun:test';
import type { LayoutNode } from '@plannotator/vendor-pierre-layouts';
import * as L from './layoutModel';
import { outerEdgeAt, outerPlace, outerRect, OUTER_ZONE } from './outerEdge';

const GAP = 8;
const ROOM = { 1440: { width: 1036, height: 884 }, 1728: { width: 1324, height: 1101 }, 1920: { width: 1516, height: 1064 } } as const;
const pane = (id: string) => L.paneNode(id);

/** The owner's layout: two rows of two over one full-width row (p1 active, then p2…p5 by recency). */
function ownerLayout(): L.FreeLayout {
  const root: LayoutNode = {
    type: 'split',
    id: 'split-1',
    direction: 'vertical',
    sizes: [1, 1, 1],
    children: [
      { type: 'split', id: 'split-2', direction: 'horizontal', sizes: [1, 1], children: [pane('p1'), pane('p2')] },
      { type: 'split', id: 'split-3', direction: 'horizontal', sizes: [1, 1], children: [pane('p3'), pane('p4')] },
      pane('p5'),
    ],
  };
  return { root, threads: { p1: 't1', p2: 't2', p3: 't3', p4: 't4', p5: 't5' }, active: 'p1', recent: ['p1', 'p2', 'p3', 'p4', 'p5'], serial: 6 };
}
const single = (): L.FreeLayout => L.follow(L.EMPTY_LAYOUT, 't1');
/** Three columns where the room holds two: the least recent (p3) already stepped aside. */
const threeColumns = (): L.FreeLayout => {
  let layout = L.openAt(single(), 't2', 'main', 'right');
  layout = L.openAt(layout, 't3', layout.active!, 'right');
  return L.focus(L.focus(layout, 'p1'), 'main');
};
const thread = (threadId: string) => ({ kind: 'thread' as const, threadId });

describe('a drop at the whole layout edge: where it goes and whether it fits', () => {
  const cases: [name: string, layout: () => L.FreeLayout, edge: L.Edge, room: { width: number; height: number }, fits: boolean][] = [
    // 3 x 400 + 2 x 8 = 1216 px for a third column: 1036 px (1440) is 180 short.
    ["owner's 2x2 over 1 at 1440: right", ownerLayout, 'right', ROOM[1440], false],
    ["owner's 2x2 over 1 at 1440: left", ownerLayout, 'left', ROOM[1440], false],
    ["owner's 2x2 over 1 at 1440: below", ownerLayout, 'bottom', ROOM[1440], false],
    // 1324 px (1728) holds the 1216 px of a third column.
    ["owner's 2x2 over 1 at 1728: right", ownerLayout, 'right', ROOM[1728], true],
    ["owner's 2x2 over 1 at 1728: left", ownerLayout, 'left', ROOM[1728], true],
    // 4 x 260 + 3 x 8 = 1064 px for a fourth row: 1101 px holds it.
    ["owner's 2x2 over 1 at 1728: below", ownerLayout, 'bottom', ROOM[1728], true],
    ["owner's 2x2 over 1 at 1920: right", ownerLayout, 'right', ROOM[1920], true],
    ['a single pane at 1440: right', single, 'right', ROOM[1440], true],
    ['a single pane at 1440: left', single, 'left', ROOM[1440], true],
    ['three columns, one stepped aside, at 1036 px: right', threeColumns, 'right', { width: 1036, height: 884 }, false],
    // 4 x 400 + 3 x 8 = 1624 px for a fourth column: 1324 px (1728) and 1516 px (1920) do not hold it, 1800 px does.
    ['three columns at 1728: right', threeColumns, 'right', ROOM[1728], false],
    ['three columns at 1920: right', threeColumns, 'right', ROOM[1920], false],
    ['three columns with 1800 px: right', threeColumns, 'right', { width: 1800, height: 1064 }, true],
  ];
  for (const [name, layout, edge, room, fits] of cases) {
    test(`${name}: ${fits ? 'fits' : 'no room'}`, () => {
      const before = layout();
      const place = outerPlace(before, thread('t9'), edge, room, GAP)!;
      expect(place).not.toBeNull();
      expect(place.fits).toBe(fits);
      // Wherever it goes, it is the root's first or last child, spanning the whole area across.
      const root = place.next.root!;
      expect(root.type).toBe('split');
      if (root.type !== 'split') return;
      expect(root.direction).toBe(edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical');
      const end = edge === 'left' || edge === 'top' ? root.children[0]! : root.children.at(-1)!;
      expect(end.type).toBe('pane');
      expect(place.next.threads[end.id]).toBe('t9');
      expect(place.next.active).toBe(end.id);
    });
  }

  test("owner's layout, right: the old grid and the new column side by side, the column one column's share (1/3), not half", () => {
    const place = outerPlace(ownerLayout(), thread('t9'), 'right', ROOM[1920], GAP)!;
    const root = place.next.root!;
    if (root.type !== 'split') throw new Error('a split');
    expect(root.children.map((child) => child.id)).toEqual(['split-1', 'p6']);
    expect((root.sizes[1] as number) / ((root.sizes[0] as number) + (root.sizes[1] as number))).toBeCloseTo(1 / 3, 5);
    // Every other pane keeps its place in the grid.
    expect(L.panesOf(root).map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  });

  test('a row of panes, left: joins the root row (the engine shape: no split in a split of its own direction), one share of three', () => {
    const pair = L.openAt(single(), 't2', 'main', 'right');
    const place = outerPlace(pair, thread('t9'), 'left', ROOM[1920], GAP)!;
    const root = place.next.root!;
    if (root.type !== 'split') throw new Error('a split');
    expect(root.children.map((child) => child.id)).toEqual(['p2', 'main', 'p1']);
    const sizes = root.sizes as number[];
    expect(sizes[0]! / sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1 / 3, 5);
  });

  test('a pane carried there moves (its thread and the active pane stay); one already that whole side changes nothing', () => {
    const owner = ownerLayout();
    const moved = outerPlace(owner, { kind: 'pane', paneId: 'p4' }, 'right', ROOM[1920], GAP)!;
    expect(moved.fits).toBe(true);
    expect(moved.next.active).toBe('p1');
    expect(moved.next.threads).toEqual(owner.threads);
    const root = moved.next.root!;
    if (root.type !== 'split') throw new Error('a split');
    expect(root.children.at(-1)!.id).toBe('p4');
    // p4 is the whole right side now: dropping it there again is no move.
    expect(outerPlace(moved.next, { kind: 'pane', paneId: 'p4' }, 'right', ROOM[1920], GAP)).toBeNull();
    // The one pane there is: nowhere to move it.
    expect(outerPlace(single(), { kind: 'pane', paneId: 'main' }, 'right', ROOM[1920], GAP)).toBeNull();
  });

  test('a thread already in a pane: that pane moves there, no second pane for it', () => {
    const place = outerPlace(ownerLayout(), thread('t2'), 'right', ROOM[1920], GAP)!;
    expect(L.panesOf(place.next.root).length).toBe(5);
    expect(place.next.active).toBe('p2');
    const root = place.next.root!;
    if (root.type !== 'split') throw new Error('a split');
    expect(root.children.at(-1)!.id).toBe('p2');
  });

  test('no pane open: no outer place', () => {
    expect(outerPlace(L.EMPTY_LAYOUT, thread('t9'), 'right', ROOM[1920], GAP)).toBeNull();
  });
});

describe('the rim strip and its zone', () => {
  const area = { left: 600, top: 8, right: 1700, bottom: 1100 };
  test('only the strip along the rim, and the nearer side at a corner; never inside a pane edge zone, never outside', () => {
    expect(outerEdgeAt(1700 - 4, 500, area)).toBe('right');
    expect(outerEdgeAt(600 + OUTER_ZONE, 500, area)).toBe('left');
    expect(outerEdgeAt(600 + OUTER_ZONE + 1, 500, area)).toBeNull();
    expect(outerEdgeAt(1000, 1100 - 2, area)).toBe('bottom');
    expect(outerEdgeAt(1000, 12, area)).toBe('top');
    expect(outerEdgeAt(1698, 20, area)).toBe('right');
    expect(outerEdgeAt(1710, 500, area)).toBeNull();
    // A pane's own edge zone is 28% of its width: well past the strip for any pane at its 400 px minimum or wider.
    expect(OUTER_ZONE).toBeLessThan(L.PANE_MIN_WIDTH * 0.28);
  });

  test("the preview is the column's own strip: full height at the right end, its share of the width", () => {
    const place = outerPlace(ownerLayout(), thread('t9'), 'right', ROOM[1920], GAP)!;
    const rect = outerRect(area, 'right', place.next, GAP);
    expect(rect.top).toBe(8);
    expect(rect.height).toBe(1092);
    expect(rect.left + rect.width).toBe(1700);
    expect(rect.width).toBeCloseTo((1100 - GAP) / 3, 5);
  });

  test('a column that stepped aside takes no share of the preview: the new column shares the area with what draws', () => {
    // Three columns a | b | c and the new one on the right, c (p2) stepped aside: the new column's share is of the
    // drawn three's weights and room (two gaps), not of all four's (three gaps).
    const three = L.openAt(L.openAt(single(), 't2', 'main', 'right'), 't3', 'p1', 'right');
    const place = outerPlace(three, thread('t9'), 'right', { width: 4000, height: 1000 }, GAP)!;
    const root = place.next.root!;
    if (root.type !== 'split') throw new Error('a split');
    expect(root.children.map((child) => child.id)).toEqual(['main', 'p1', 'p2', 'p3']);
    const [a, b, c, n] = root.sizes as number[];
    expect(outerRect(area, 'right', place.next, GAP).width).toBeCloseTo(((1100 - 3 * GAP) * n!) / (a! + b! + c! + n!), 5);
    expect(outerRect(area, 'right', place.next, GAP, new Set(['p2'])).width).toBeCloseTo(((1100 - 2 * GAP) * n!) / (a! + b! + n!), 5);
  });
});
