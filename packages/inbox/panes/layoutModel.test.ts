/**
 * The free layout's data (layoutModel.ts), how it gives way for room (layoutRoom.ts), and what is kept for the window
 * (savedLayout.ts).
 *
 * What regresses: a pane dropped at an edge landing elsewhere or taking another's thread; a thread showing in two
 * panes; closing a pane leaving a hole, the wrong pane active, or the last pane not giving back today's empty window;
 * a moved pane's thread or size lost; a narrow window hiding the active pane or the wrong one first, or not showing one
 * pane alone below two columns; "Open to the side" placing differently for the same layout and room, splitting where a
 * pane steps aside while another place fits, or refusing where nothing fits; a kept layout read back wrong, or a broken
 * one read at all.
 */
import { describe, expect, test } from 'bun:test';
import type { LayoutNode } from '@plannotator/vendor-pierre-layouts';
import * as L from './layoutModel';
import { hiddenForRoom, minimumSize, neighbor, placeToSide, type PaneRect, type SidePlace } from './layoutRoom';
import { decodeLayout, encodeLayout } from './savedLayout';

/** The tree as nested words: `a|b` side by side, `a/b` one over the other. */
function shape(layout: L.FreeLayout): string {
  const of = (node: LayoutNode): string =>
    node.type === 'pane' ? layout.threads[node.id]! : `(${node.children.map(of).join(node.type === 'split' && node.direction === 'horizontal' ? '|' : '/')})`;
  return layout.root ? of(layout.root) : '';
}

const one = L.follow(L.EMPTY_LAYOUT, 'a');
const two = L.openAt(one, 'b', 'main', 'right');

describe('free layout', () => {
  test('the first thread opens one pane, `main`, as a window without the switch has', () => {
    expect(one.root).toEqual(L.paneNode('main'));
    expect(L.activeThread(one)).toBe('a');
  });

  test('a thread opens at each edge of a pane, and the person is in it', () => {
    expect(shape(L.openAt(one, 'b', 'main', 'left'))).toBe('(b|a)');
    expect(shape(L.openAt(one, 'b', 'main', 'right'))).toBe('(a|b)');
    expect(shape(L.openAt(one, 'b', 'main', 'top'))).toBe('(b/a)');
    expect(shape(L.openAt(one, 'b', 'main', 'bottom'))).toBe('(a/b)');
    expect(L.activeThread(two)).toBe('b');
    // Beside a pane in a row of the other direction, the row gets a column, not a third flat child.
    expect(shape(L.openAt(two, 'c', 'main', 'bottom'))).toBe('((a/c)|b)');
  });

  test('one thread shows in one pane: opening it again elsewhere moves its pane, or makes it active', () => {
    const back = L.focus(two, 'main');
    expect(L.follow(back, 'b').active).toBe(two.active);
    expect(L.replace(back, 'main', 'b').active).toBe(two.active);
    const moved = L.openAt(back, 'b', 'main', 'left');
    expect(shape(moved)).toBe('(b|a)');
    expect(Object.values(moved.threads).sort()).toEqual(['a', 'b']);
  });

  test("a row on a pane's centre takes its place there; the address following a thread changes only the active pane", () => {
    const three = L.openAt(two, 'c', 'main', 'bottom');
    expect(shape(L.replace(three, 'main', 'd'))).toBe('((d/c)|b)');
    expect(shape(L.follow(three, 'd'))).toBe('((a/d)|b)');
  });

  test('moving a pane keeps its thread, the active pane and the splits it leaves', () => {
    const three = L.openAt(two, 'c', 'main', 'bottom');
    const id = L.paneOfThread(three, 'b')!;
    const moved = L.move(three, id, 'main', 'top');
    expect(shape(moved)).toBe('(b/a/c)');
    expect(moved.active).toBe(three.active);
    expect(L.move(three, id, id, 'left')).toBe(three);
  });

  test('closing a pane gives its room to the rest and the most recent other pane becomes active; the last one leaves nothing', () => {
    const three = L.focus(L.openAt(two, 'c', 'main', 'bottom'), L.paneOfThread(two, 'b')!);
    const closed = L.close(three, three.active!);
    expect(shape(closed)).toBe('(a/c)');
    expect(L.activeThread(closed)).toBe('c');
    const last = L.close(L.close(closed, closed.active!), 'main');
    expect(last.root).toBeNull();
    expect(L.activeThread(last)).toBeNull();
    // Gone threads close their panes.
    expect(shape(L.closeWhere(three, (t) => t !== 'a'))).toBe('a');
  });

  test('a divider dragged changes its split only', () => {
    const split = two.root as Extract<LayoutNode, { type: 'split' }>;
    const sized = L.resize(two, { [split.id]: [2, 1] });
    expect((sized.root as typeof split).sizes).toEqual([2, 1]);
    expect(L.resize(sized, { other: [1, 1] })).toBe(sized);
  });
});

describe('room', () => {
  const four = L.openAt(L.openAt(L.openAt(one, 'b', 'main', 'right'), 'c', 'main', 'bottom'), 'd', L.paneOfThread(two, 'b')!, 'bottom');

  test('a pane keeps 400 x 260 px; a row adds widths and gaps, a column heights', () => {
    expect(minimumSize(four.root!, new Set(), 8)).toEqual({ width: 808, height: 528 });
  });

  test('when the room is too small, the least recent panes step aside first, never the active one', () => {
    const active = L.focus(four, 'main');
    const wide = { width: 1200, height: 900 };
    expect(hiddenForRoom(active, wide, 8).size).toBe(0);
    // Too short for two rows: the least recent (b, opened first after a), then c, step aside; d, more recent, stays.
    expect(active.recent.map((id) => active.threads[id])).toEqual(['a', 'd', 'c', 'b']);
    const short = hiddenForRoom(active, { width: 1200, height: 400 }, 8);
    expect([...short].map((id) => active.threads[id]).sort()).toEqual(['b', 'c']);
    // Below two columns, the active pane alone.
    const narrow = hiddenForRoom(active, { width: 807, height: 900 }, 8);
    expect([...narrow].map((id) => active.threads[id]).sort()).toEqual(['b', 'c', 'd']);
  });

  test("the menu's Move goes to the nearest pane on that side that overlaps", () => {
    const rects = [
      { id: 'a', left: 0, top: 0, right: 500, bottom: 400 },
      { id: 'b', left: 508, top: 0, right: 1000, bottom: 900 },
      { id: 'c', left: 0, top: 408, right: 500, bottom: 900 },
    ];
    expect(neighbor(rects, 'a', 'right')).toBe('b');
    expect(neighbor(rects, 'a', 'bottom')).toBe('c');
    expect(neighbor(rects, 'a', 'left')).toBeNull();
    // Two as near: the one that overlaps it more.
    expect(neighbor(rects, 'b', 'left')).toBe('c');
  });

  test('"Open to the side": right of the active pane, else below it, else the largest pane along its longer side, then its shorter, never a third pane stacked in a column, else right with the least recent stepping aside', () => {
    const gap = 8;
    const box = (id: string, left: number, top: number, right: number, bottom: number): PaneRect => ({ id, left, top, right, bottom });
    // b below c on the right of a, the person in c: (a|(b/c)).
    const three = L.openAt(two, 'c', 'p1', 'bottom');
    // Three columns, the person in c: (a|b|c); then c with e below it, the person in e: (a|b|(c/e)).
    const columns = L.openAt(two, 'c', 'p1', 'right');
    const tied = L.openAt(columns, 'e', 'p2', 'bottom');
    const cases: { name: string; layout: L.FreeLayout; room: { width: number; height: number }; rects: PaneRect[]; target: string; edge: SidePlace['edge']; shape: string; aside: string[] }[] = [
      { name: 'a third column fits', layout: two, room: { width: 1400, height: 900 }, rects: [box('main', 0, 0, 696, 900), box('p1', 704, 0, 1400, 900)], target: 'p1', edge: 'right', shape: '(a|b|d)', aside: [] },
      { name: 'no third column: below the active pane', layout: two, room: { width: 1000, height: 900 }, rects: [box('main', 0, 0, 496, 900), box('p1', 504, 0, 1000, 900)], target: 'p1', edge: 'bottom', shape: '(a|(b/d))', aside: [] },
      { name: 'the active pane too short for another row: the largest pane, taller than wide, split below', layout: three, room: { width: 1000, height: 700 }, rects: [box('main', 0, 0, 496, 700), box('p1', 504, 0, 1000, 346), box('p2', 504, 354, 1000, 700)], target: 'main', edge: 'bottom', shape: '((a/d)|(b/c))', aside: [] },
      { name: 'room for a third row below the active pane, but no column stacks three: the largest pane, taller than wide, split below', layout: three, room: { width: 1000, height: 900 }, rects: [box('main', 0, 0, 496, 900), box('p1', 504, 0, 1000, 446), box('p2', 504, 454, 1000, 900)], target: 'main', edge: 'bottom', shape: '((a/d)|(b/c))', aside: [] },
      { name: 'every column two high and no pane to halve: right of the active pane, the least recent steps aside, never a third row', layout: three, room: { width: 1000, height: 900 }, rects: [], target: 'p2', edge: 'right', shape: '(a|(b/(c|d)))', aside: ['a'] },
      { name: 'the largest pane wider than tall but too narrow to halve across: split below instead', layout: three, room: { width: 1200, height: 700 }, rects: [box('main', 0, 0, 760, 700), box('p1', 768, 0, 1200, 346), box('p2', 768, 354, 1200, 700)], target: 'main', edge: 'bottom', shape: '((a/d)|(b/c))', aside: [] },
      { name: 'two panes as large: the earlier in the tree is split', layout: tied, room: { width: 1500, height: 600 }, rects: [box('main', 0, 0, 495, 600), box('p1', 503, 0, 998, 600), box('p2', 1006, 0, 1500, 296), box('p3', 1006, 304, 1500, 600)], target: 'main', edge: 'bottom', shape: '((a/d)|b|(c/e))', aside: [] },
      { name: 'a pane already aside does not count against a place: below the active pane fits with a still aside', layout: columns, room: { width: 1000, height: 900 }, rects: [box('p1', 0, 0, 496, 900), box('p2', 504, 0, 1000, 900)], target: 'p2', edge: 'bottom', shape: '(a|b|(c/d))', aside: [] },
      { name: 'nothing fits: right of the active pane, the least recent steps aside', layout: two, room: { width: 1000, height: 500 }, rects: [box('main', 0, 0, 496, 500), box('p1', 504, 0, 1000, 500)], target: 'p1', edge: 'right', shape: '(a|b|d)', aside: ['a'] },
      { name: 'below two columns of room: the new pane alone, the other stepped aside', layout: one, room: { width: 800, height: 900 }, rects: [box('main', 0, 0, 800, 900)], target: 'main', edge: 'right', shape: '(a|d)', aside: ['a'] },
    ];
    for (const c of cases) {
      const place = placeToSide(c.layout, 'd', c.room, gap, c.rects);
      expect({ target: place.target, edge: place.edge, shape: shape(place.next), aside: place.stepsAside.map((id) => c.layout.threads[id]) }, c.name).toEqual({ target: c.target, edge: c.edge, shape: c.shape, aside: c.aside });
      expect(L.activeThread(place.next), c.name).toBe('d');
      // The same layout and room place the same way every time.
      expect(placeToSide(c.layout, 'd', c.room, gap, c.rects), c.name).toEqual(place);
    }
  });
});

describe('kept layout', () => {
  test('a layout of two panes or more reads back as it was; one pane is not kept', () => {
    const sized = L.resize(two, { [(two.root as { id: string }).id]: [3, 1] });
    expect(decodeLayout(encodeLayout(sized))).toEqual(sized);
    expect(encodeLayout(one)).toBeNull();
  });

  test('a layout kept under the old 440 px minimum reads back with every pane at the current minimum', () => {
    const saved = JSON.parse(encodeLayout(two)!);
    const old = (node: { type: string; minWidth?: number; children?: unknown[] }): void => {
      if (node.type === 'pane') node.minWidth = 440;
      node.children?.forEach((child) => old(child as typeof node));
    };
    old(saved.tree.root);
    const read = decodeLayout(JSON.stringify(saved));
    expect(L.panesOf(read.root).map((pane) => [pane.id, pane.minWidth])).toEqual(L.panesOf(two.root).map((pane) => [pane.id, L.PANE_MIN_WIDTH]));
  });

  test('anything broken reads as no layout', () => {
    const text = encodeLayout(two)!;
    for (const broken of [
      'nope',
      text.replace('"active":"p1"', '"active":"zz"'),
      text.replace('"b"', '"a"'),
      text.replace('"version":3', '"version":2'),
      JSON.stringify({ ...JSON.parse(text), threads: { main: 'a' } }),
    ]) {
      expect(decodeLayout(broken)).toEqual(L.EMPTY_LAYOUT);
    }
  });
});
