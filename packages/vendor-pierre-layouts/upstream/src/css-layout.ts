import { divide } from './divide';
import { childSpecs, separatorId, visibleChildren } from './geometry';
import { collapsedSizeOf, isFixed, shownPane } from './model';
import {
  add,
  compose,
  constant,
  max,
  min,
  type Piecewise,
  scale,
  size,
  toCSS,
} from './piecewise';
import type {
  ChildSize,
  Edge,
  LayoutNode,
  PaneNode,
  SplitNode,
  StackNode,
} from './types';

export type PaneEdges = Readonly<Record<Edge, boolean>>;

export const ALL_EDGES: PaneEdges = Object.freeze({
  top: true,
  right: true,
  bottom: true,
  left: true,
});

const NO_EDGES: PaneEdges = Object.freeze({
  top: false,
  right: false,
  bottom: false,
  left: false,
});

export interface CSSRect {
  left: string;
  top: string;
  width: string;
  height: string;
}

export interface CSSPane {
  pane: PaneNode;
  rect: CSSRect;
  /**
   * The pane does not show: it is hidden, a split above it holds only hidden
   * panes, or it is a pane of a stack that is not active. Its rect is the box
   * that it would have if it showed, so it shows again in place.
   */
  hidden: boolean;
  /** The stack that holds the pane, or null. */
  stack: StackNode | null;
  /**
   * The pane, or its stack, is collapsed in a split: it takes its collapsed
   * size, and its content does not render.
   */
  collapsed: boolean;
  edges: PaneEdges;
}

export interface CSSSeparator {
  /** The ID of the separator (see `separatorId`). */
  id: string;
  split: SplitNode;
  /** The index in `split.children` of the child after the separator. */
  index: number;
  /** The visible child before the separator. */
  before: LayoutNode;
  /**
   * The preferred place of the separator in the split, from 0 to 1: the
   * weights of the visible children before it over those of all visible
   * children. A child with a size in pixels counts with that size against
   * `PREFERRED_FLEX_PX` of space for the weighted children, because its share
   * depends on the size of the container.
   */
  value: number;
  rect: CSSRect;
}

export interface CSSCorner {
  id: string;
  separatorIds: readonly string[];
  left: string;
  top: string;
}

export interface CSSLayout {
  panes: CSSPane[];
  separators: CSSSeparator[];
  corners: CSSCorner[];
}

/**
 * The IDs of the separators that meet one edge of a subtree at a right angle,
 * independently of the container size.
 */
function boundarySeparators(
  node: LayoutNode,
  edge: 'left' | 'right' | 'top' | 'bottom'
): string[] {
  if (node.type !== 'split') return [];
  const visible = visibleChildren(node);
  if (visible.length === 1)
    return boundarySeparators(node.children[visible[0]], edge);
  const start = edge === 'left' || edge === 'top';
  if (
    (node.direction === 'horizontal') ===
    (edge === 'left' || edge === 'right')
  )
    return boundarySeparators(
      node.children[start ? visible[0] : visible[visible.length - 1]],
      edge
    );
  return [
    ...visible.slice(1).map((index) => separatorId(node, index)),
    ...visible.flatMap((index) =>
      boundarySeparators(node.children[index], edge)
    ),
  ];
}

interface Box {
  left: Piecewise;
  top: Piecewise;
  width: Piecewise;
  height: Piecewise;
}

const toRect = (box: Box): CSSRect => ({
  left: toCSS(box.left, '100cqw'),
  top: toCSS(box.top, '100cqh'),
  width: toCSS(box.width, '100cqw'),
  height: toCSS(box.height, '100cqh'),
});

// The space of the weighted children of a split, for the preferred place of
// a separator in a split with sizes in pixels.
const PREFERRED_FLEX_PX = 1000;

/**
 * The length that each child would take in a split with `PREFERRED_FLEX_PX`
 * of space for the weighted children. With weights only, these are the
 * weights.
 */
function preferredLengths(sizes: readonly ChildSize[]): number[] {
  if (!sizes.some(isFixed)) return sizes as number[];
  const total = sizes.reduce<number>(
    (sum, size) => sum + (isFixed(size) ? 0 : size),
    0
  );
  return sizes.map((size) =>
    isFixed(size) ? size.px : (size / total) * PREFERRED_FLEX_PX
  );
}

/**
 * Compile the split tree to one CSS value for each property of each element,
 * once per tree change. Each horizontal edge is a piecewise-linear function of
 * the container width, and each vertical edge of its height, so `toCSS` writes
 * it with container units and one hinge term for each size at which a minimum
 * size or a gap starts to apply. The browser resolves container resizes with
 * no script, and a size change restyles only the elements whose values change.
 */
export function computeCSSLayout(root: LayoutNode, gap = 8): CSSLayout {
  if (!Number.isFinite(gap) || gap < 0)
    throw new Error('Layout gap must be finite and non-negative');
  const panes: CSSPane[] = [];
  const separators: (Omit<CSSSeparator, 'rect'> & { box: Box })[] = [];
  function visit(
    node: LayoutNode,
    box: Box,
    hidden: boolean,
    edges: PaneEdges
  ): void {
    // The root fills the container, so it does not collapse.
    const collapsed = node !== root && collapsedSizeOf(node) !== null;
    if (node.type === 'pane') {
      panes.push({
        pane: node,
        rect: toRect(box),
        hidden: hidden || node.hidden === true,
        stack: null,
        collapsed,
        edges: hidden || node.hidden === true ? NO_EDGES : edges,
      });
      return;
    }
    // Each pane of a stack has the box of the stack, so a change of tab
    // changes no value of a box.
    if (node.type === 'stack') {
      const shown = shownPane(node);
      const rect = toRect(box);
      for (const child of node.children)
        panes.push({
          pane: child,
          rect,
          hidden: hidden || child !== shown,
          stack: node,
          collapsed,
          edges: hidden || child !== shown ? NO_EDGES : edges,
        });
      return;
    }
    const all = node.children.map((_, index) => index);
    const visible = hidden ? all : visibleChildren(node);
    const shown = placeChildren(node, visible, box);
    if (!hidden) {
      const weights = preferredLengths(
        visible.map((index) => node.sizes[index])
      );
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let before = 0;
      visible.forEach((index, order) => {
        if (order > 0)
          separators.push({
            id: separatorId(node, index),
            split: node,
            index,
            before: node.children[visible[order - 1]],
            value: before / total,
            box: shown.handles[order - 1],
          });
        before += weights[order];
      });
    }
    // A hidden child keeps the box that it would have if it were visible.
    const wouldHave =
      visible.length === all.length ? shown : placeChildren(node, all, box);
    const [start, end]: [Edge, Edge] =
      node.direction === 'horizontal' ? ['left', 'right'] : ['top', 'bottom'];
    node.children.forEach((child, index) => {
      const order = visible.indexOf(index);
      visit(
        child,
        order === -1 ? wouldHave.boxes[index] : shown.boxes[order],
        hidden || order === -1,
        order === -1
          ? NO_EDGES
          : {
              ...edges,
              [start]: edges[start] && order === 0,
              [end]: edges[end] && order === visible.length - 1,
            }
      );
    });
  }
  /**
   * The boxes of some children of a split, in order, and of the separators
   * between them. The children share the box of the split with `divide`.
   */
  function placeChildren(
    node: SplitNode,
    indexes: readonly number[],
    box: Box
  ): { boxes: Box[]; handles: Box[] } {
    if (indexes.length === 1) return { boxes: [box], handles: [] };
    const horizontal = node.direction === 'horizontal';
    const axis = horizontal ? 'width' : 'height';
    const position = horizontal ? 'left' : 'top';
    const separatorCount = indexes.length - 1;
    // The gaps shrink in a container smaller than the gaps.
    const actualGap = min(constant(gap), scale(box[axis], 1 / separatorCount));
    const available = max(
      constant(0),
      add(box[axis], scale(actualGap, -separatorCount))
    );
    // Each child's size is a function of the space of the split, and that
    // space is a function of the container size.
    const sizes = divide(childSpecs(node, indexes, gap)).map((share) =>
      compose(share, available)
    );
    // The last child gets the rest, so that the sizes add up to the space.
    sizes[sizes.length - 1] = sizes
      .slice(0, -1)
      .reduce((rest, value) => add(rest, scale(value, -1)), available);
    const boxes: Box[] = [];
    const handles: Box[] = [];
    let start = box[position];
    sizes.forEach((childSize, order) => {
      if (order > 0) {
        handles.push({ ...box, [position]: start, [axis]: actualGap });
        start = add(start, actualGap);
      }
      boxes.push({ ...box, [position]: start, [axis]: childSize });
      start = add(start, childSize);
    });
    return { boxes, handles };
  }
  visit(
    root,
    {
      left: constant(0),
      top: constant(0),
      width: size(),
      height: size(),
    },
    false,
    ALL_EDGES
  );
  const byId = new Map(
    separators.map((separator) => [separator.id, separator])
  );
  const corners: CSSCorner[] = [];
  for (const separator of separators) {
    const horizontal = separator.split.direction === 'horizontal';
    const adjacent = [
      ...boundarySeparators(separator.before, horizontal ? 'right' : 'bottom'),
      ...boundarySeparators(
        separator.split.children[separator.index],
        horizontal ? 'left' : 'top'
      ),
    ];
    for (const otherId of adjacent) {
      const other = byId.get(otherId);
      if (other === undefined) continue;
      const h = horizontal ? separator : other;
      const v = horizontal ? other : separator;
      const id = `${h.id}:${v.id}`;
      if (corners.some((corner) => corner.id === id)) continue;
      corners.push({
        id,
        separatorIds: [h.id, v.id],
        left: toCSS(
          add(add(h.box.left, scale(h.box.width, 0.5)), constant(-7)),
          '100cqw'
        ),
        top: toCSS(
          add(add(v.box.top, scale(v.box.height, 0.5)), constant(-7)),
          '100cqh'
        ),
      });
    }
  }
  return {
    panes,
    separators: separators.map(({ box, ...separator }) => ({
      ...separator,
      rect: toRect(box),
    })),
    corners,
  };
}
