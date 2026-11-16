import { divideSpace } from './divide';
import { getExitEdge } from './geometry';
import { isFixed } from './model';
import type {
  ChildExtent,
  ChildSize,
  Edge,
  LayoutGeometry,
  Rect,
  SeparatorGeometry,
} from './types';

/** Where a dragged pane goes: beside a pane, at one of its edges, and the box that shows it. */
export interface DropTarget {
  paneId: string;
  edge: Edge;
  rect: Rect;
}

export type DropPlace = Edge | 'center';

export interface TabDropTarget {
  paneId: string;
  place: DropPlace;
  rect: Rect;
}

const EDGE_X_FRACTION = 0.28;
const EDGE_Y_FRACTION = 0.3;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/** The place of the separator among the visible children of its split. */
const orderOf = (separator: SeparatorGeometry): number =>
  separator.children.findIndex(({ index }) => index === separator.index);

/**
 * The pixel sizes of the visible children of a split after a separator moved
 * by `delta` pixels. The children on the side that the separator moves into
 * shrink, the nearest first, each down to its minimum size. The children on
 * the other side grow by the same amount, the nearest first, each up to its
 * maximum size. So a move changes only the two children beside the
 * separator, until one reaches its minimum or its maximum size.
 */
export function moveSeparator(
  children: readonly ChildExtent[],
  order: number,
  delta: number
): number[] {
  const sizes = children.map(({ size }) => size);
  const before = sizes
    .map((_, index) => order - 1 - index)
    .filter((index) => index >= 0);
  const after = sizes
    .map((_, index) => order + index)
    .filter((index) => index < sizes.length);
  const [shrinking, growing] = delta < 0 ? [before, after] : [after, before];
  const room = (indexes: number[], limit: (index: number) => number): number =>
    indexes.reduce((total, index) => total + Math.max(0, limit(index)), 0);
  const distance = Math.min(
    Math.abs(delta),
    room(shrinking, (index) => sizes[index] - children[index].min),
    room(growing, (index) => children[index].max - sizes[index])
  );
  let shrink = distance;
  for (const index of shrinking) {
    const taken = Math.min(
      shrink,
      Math.max(0, sizes[index] - children[index].min)
    );
    sizes[index] -= taken;
    shrink -= taken;
  }
  let grow = distance;
  for (const index of growing) {
    const given = Math.min(
      grow,
      Math.max(0, children[index].max - sizes[index])
    );
    sizes[index] += given;
    grow -= given;
  }
  return sizes;
}

/**
 * The sizes of a split from the pixel sizes of its visible children. A child
 * with a size in pixels takes its new size. The weighted visible children
 * keep the sum of their weights and share it by their pixel sizes. Hidden
 * children keep their sizes.
 */
function toWeights(
  separator: SeparatorGeometry,
  pixels: readonly number[]
): ChildSize[] {
  const { split, children } = separator;
  const sizes = [...split.sizes];
  const weighted = children
    .map(({ index }, order) => ({ index, order }))
    .filter(({ index }) => !isFixed(split.sizes[index]));
  const space = sum(weighted.map(({ order }) => pixels[order]));
  const weight = sum(weighted.map(({ index }) => split.sizes[index] as number));
  children.forEach(({ index }, order) => {
    const size = split.sizes[index];
    if (isFixed(size)) sizes[index] = { px: pixels[order] };
    else if (space > 0)
      // A weight stays positive when a child has no minimum size.
      sizes[index] = (Math.max(pixels[order], space * 0.001) / space) * weight;
  });
  return sizes;
}

/**
 * The sizes of the dragged splits after the pointer moved by `dx` and `dy`
 * pixels from where the drag started (see `moveSeparator`).
 */
export function dragSizes(
  separators: readonly SeparatorGeometry[],
  dx: number,
  dy: number
): Record<string, ChildSize[]> {
  const sizes: Record<string, ChildSize[]> = {};
  for (const separator of separators) {
    const delta = separator.split.direction === 'horizontal' ? dx : dy;
    sizes[separator.split.id] = toWeights(
      separator,
      moveSeparator(separator.children, orderOf(separator), delta)
    );
  }
  return sizes;
}

/**
 * The sizes after a key press on a separator or a corner: arrow keys move the
 * separator by 2% of the split (10% with Shift), Home and End move it until
 * the child before or after it has its minimum size, and Enter gives the two
 * children beside it the same size. Null when the key does not resize.
 */
export function keySizes(
  separators: readonly SeparatorGeometry[],
  key: string,
  shift: boolean
): Record<string, ChildSize[]> | null {
  const sizes: Record<string, ChildSize[]> = {};
  for (const separator of separators) {
    const horizontal = separator.split.direction === 'horizontal';
    const order = orderOf(separator);
    const before = separator.children[order - 1];
    const after = separator.children[order];
    const step =
      (shift ? 0.1 : 0.02) * sum(separator.children.map(({ size }) => size));
    const delta =
      key === (horizontal ? 'ArrowLeft' : 'ArrowUp')
        ? -step
        : key === (horizontal ? 'ArrowRight' : 'ArrowDown')
          ? step
          : key === 'Home'
            ? -Math.max(0, before.size - before.min)
            : key === 'End'
              ? Math.max(0, after.size - after.min)
              : key === 'Enter'
                ? (after.size - before.size) / 2
                : null;
    if (delta !== null)
      sizes[separator.split.id] = toWeights(
        separator,
        moveSeparator(separator.children, order, delta)
      );
  }
  return Object.keys(sizes).length > 0 ? sizes : null;
}

/**
 * How far a separator moves along its split, in pixels, when the split takes
 * new sizes.
 */
export function separatorOffset(
  separator: SeparatorGeometry,
  sizes: readonly ChildSize[]
): number {
  const order = orderOf(separator);
  const { children } = separator;
  const space = sum(children.map(({ size }) => size));
  const next = divideSpace(
    space,
    children.map(({ index, min, max }) => {
      const size = sizes[index];
      return {
        px: isFixed(size) ? size.px : undefined,
        weight: isFixed(size) ? 1 : size,
        min,
        max,
      };
    })
  );
  return (
    sum(next.slice(0, order)) -
    sum(children.slice(0, order).map(({ size }) => size))
  );
}

/**
 * The tab boundary nearest to a point in a tab list: the number of tabs whose
 * middle is before the point, from 0 (before the first tab) to the number of
 * tabs (after the last).
 */
export function tabBoundaryAt(
  edges: readonly { left: number; right: number }[],
  x: number
): number {
  return edges.filter(({ left, right }) => (left + right) / 2 < x).length;
}

/**
 * The index for `store.moveTab` of a tab that moves to a boundary of its tab
 * list, or null when the tab stays in place. `visible` holds the IDs of the
 * tabs that the list shows, in order; `order` holds the IDs of all the panes
 * of the stack, hidden ones included. The tab goes before the visible tab at
 * the boundary, or after the last visible tab.
 */
export function tabMoveIndex(
  order: readonly string[],
  visible: readonly string[],
  id: string,
  boundary: number
): number | null {
  const at = visible.indexOf(id);
  if (at === -1 || boundary === at || boundary === at + 1) return null;
  const shown = visible.filter((other) => other !== id);
  const others = order.filter((other) => other !== id);
  const place = boundary > at ? boundary - 1 : boundary;
  return place < shown.length
    ? others.indexOf(shown[place])
    : others.indexOf(shown[shown.length - 1]) + 1;
}

/** The pane under a point of the layout, other than the pane that moves. */
export function paneAt(
  geometry: LayoutGeometry,
  x: number,
  y: number,
  except: string
): LayoutGeometry['panes'][number] | undefined {
  return geometry.panes.find(
    ({ pane, rect }) =>
      pane.id !== except &&
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
  );
}

/** Pick the closest side of a pane and show exactly where a dragged pane will be inserted. */
export function dropTarget(
  paneId: string,
  rect: Rect,
  x: number,
  y: number
): DropTarget {
  const sides: [Edge, number][] = [
    ['left', (x - rect.x) / rect.width],
    ['right', (rect.x + rect.width - x) / rect.width],
    ['top', (y - rect.y) / rect.height],
    ['bottom', (rect.y + rect.height - y) / rect.height],
  ];
  const edge = sides.sort((a, b) => a[1] - b[1])[0][0];
  return {
    paneId,
    edge,
    rect: {
      x: rect.x + (edge === 'right' ? rect.width / 2 : 0),
      y: rect.y + (edge === 'bottom' ? rect.height / 2 : 0),
      width: edge === 'left' || edge === 'right' ? rect.width / 2 : rect.width,
      height:
        edge === 'top' || edge === 'bottom' ? rect.height / 2 : rect.height,
    },
  };
}

/**
 * The edge past which each pane leaves when another pane zooms, from the
 * boxes of the panes (keyed `pane:<id>`) and the size of the layout.
 */
export function getExitEdges(
  boxes: ReadonlyMap<string, Rect>,
  width: number,
  height: number
): Record<string, Edge> {
  const edges: Record<string, Edge> = {};
  for (const [key, box] of boxes) {
    if (key.startsWith('pane:'))
      edges[key.slice(5)] = getExitEdge(box, width, height);
  }
  return edges;
}
export function dropPlace(rect: Rect, x: number, y: number): DropPlace {
  const px = rect.width > 0 ? (x - rect.x) / rect.width : 0.5;
  const py = rect.height > 0 ? (y - rect.y) / rect.height : 0.5;
  if (px < EDGE_X_FRACTION) return 'left';
  if (px > 1 - EDGE_X_FRACTION) return 'right';
  if (py < EDGE_Y_FRACTION) return 'top';
  if (py > 1 - EDGE_Y_FRACTION) return 'bottom';
  return 'center';
}

export function placeRect(rect: Rect, place: DropPlace): Rect {
  return {
    x: rect.x + (place === 'right' ? rect.width / 2 : 0),
    y: rect.y + (place === 'bottom' ? rect.height / 2 : 0),
    width: place === 'left' || place === 'right' ? rect.width / 2 : rect.width,
    height:
      place === 'top' || place === 'bottom' ? rect.height / 2 : rect.height,
  };
}

export function tabDropTarget(
  geometry: LayoutGeometry,
  x: number,
  y: number,
  tabId: string,
  group: readonly string[],
  center = false
): TabDropTarget | null {
  const hit = paneAt(geometry, x, y, '');
  if (hit === undefined) return null;
  const place = center ? 'center' : dropPlace(hit.rect, x, y);
  if (!group.includes(hit.pane.id))
    return { paneId: hit.pane.id, place, rect: placeRect(hit.rect, place) };
  const sibling =
    hit.pane.id === tabId ? group.find((id) => id !== tabId) : hit.pane.id;
  if (place === 'center' || sibling === undefined) return null;
  return { paneId: sibling, place, rect: placeRect(hit.rect, place) };
}

export function tabInsertIndex(
  order: readonly string[],
  visible: readonly string[],
  boundary: number
): number {
  if (visible.length === 0) return order.length;
  return boundary < visible.length
    ? order.indexOf(visible[boundary])
    : order.indexOf(visible[visible.length - 1]) + 1;
}
