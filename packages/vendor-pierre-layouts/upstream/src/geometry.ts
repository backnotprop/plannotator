import { type ChildSpec, divideSpace } from './divide';
import { collapsedSizeOf, hasVisiblePane, isFixed, shownPane } from './model';
import type {
  ChildExtent,
  LayoutGeometry,
  LayoutNode,
  Rect,
  SeparatorGeometry,
  SplitNode,
} from './types';

const DEFAULT_MIN_WIDTH = 120;
const DEFAULT_MIN_HEIGHT = 80;

/**
 * Compute subtree minimums so resizing an ancestor respects every nested pane.
 * Hidden panes take no space, so a subtree of hidden panes has no minimum.
 */
export function getMinimumSize(
  node: LayoutNode,
  gap: number
): { width: number; height: number } {
  return minimumSize(node, gap) ?? { width: 0, height: 0 };
}

function minimumSize(
  node: LayoutNode,
  gap: number
): { width: number; height: number } | null {
  if (node.type === 'pane')
    return node.hidden === true
      ? null
      : {
          width: node.minWidth ?? DEFAULT_MIN_WIDTH,
          height: node.minHeight ?? DEFAULT_MIN_HEIGHT,
        };
  if (node.type === 'stack') {
    const sizes = node.children
      .map((child) => minimumSize(child, gap))
      .filter((size) => size !== null);
    if (sizes.length === 0) return null;
    // A stack takes the minimum size of its largest visible pane, whichever
    // pane is active, so a change of tab moves no other box.
    return {
      width: Math.max(...sizes.map(({ width }) => width)),
      height: Math.max(...sizes.map(({ height }) => height)),
    };
  }
  const sizes = alongSplit(node, (child) => minimumSize(child, gap));
  if (sizes.length === 0) return null;
  const gaps = gap * (sizes.length - 1);
  const sum = (key: 'width' | 'height'): number =>
    sizes.reduce((total, size) => total + size[key], 0);
  const most = (key: 'width' | 'height'): number =>
    Math.max(...sizes.map((size) => size[key]));
  return node.direction === 'horizontal'
    ? { width: sum('width') + gaps, height: most('height') }
    : { width: most('width'), height: sum('height') + gaps };
}

/**
 * The largest sizes of a subtree: the sum of the maximums of the children
 * along a split, with its gaps, and the smallest maximum across it. A size is
 * `Infinity` when nothing limits it, and never below the minimum size.
 */
export function getMaximumSize(
  node: LayoutNode,
  gap: number
): { width: number; height: number } {
  return maximumSize(node, gap) ?? { width: Infinity, height: Infinity };
}

function maximumSize(
  node: LayoutNode,
  gap: number
): { width: number; height: number } | null {
  const minimum = minimumSize(node, gap);
  if (minimum === null) return null;
  const atLeast = (size: { width: number; height: number }) => ({
    width: Math.max(minimum.width, size.width),
    height: Math.max(minimum.height, size.height),
  });
  if (node.type === 'pane')
    return atLeast({
      width: node.maxWidth ?? Infinity,
      height: node.maxHeight ?? Infinity,
    });
  const sizes =
    node.type === 'stack'
      ? node.children
          .map((child) => maximumSize(child, gap))
          .filter((size) => size !== null)
      : alongSplit(node, (child) => maximumSize(child, gap));
  const least = (key: 'width' | 'height'): number =>
    Math.min(...sizes.map((size) => size[key]));
  // A stack takes the smallest maximum of its visible panes, whichever pane
  // is active.
  if (node.type === 'stack')
    return atLeast({ width: least('width'), height: least('height') });
  const gaps = gap * (sizes.length - 1);
  const sum = (key: 'width' | 'height'): number =>
    sizes.reduce((total, size) => total + size[key], 0) + gaps;
  return atLeast(
    node.direction === 'horizontal'
      ? { width: sum('width'), height: least('height') }
      : { width: least('width'), height: sum('height') }
  );
}

/**
 * A size of each visible child of a split, from `measure`. A collapsed child
 * takes its collapsed size along the split, whatever its content needs.
 */
function alongSplit(
  split: SplitNode,
  measure: (child: LayoutNode) => { width: number; height: number } | null
): { width: number; height: number }[] {
  const axis = split.direction === 'horizontal' ? 'width' : 'height';
  return split.children.flatMap((child) => {
    const size = measure(child);
    if (size === null) return [];
    const collapsed = collapsedSizeOf(child);
    return [collapsed === null ? size : { ...size, [axis]: collapsed }];
  });
}

/**
 * How some children of a split take space along its axis (see `divide`): a
 * size in pixels or a weight, a minimum, and a maximum.
 */
export function childSpecs(
  split: SplitNode,
  indexes: readonly number[],
  gap: number
): ChildSpec[] {
  const axis = split.direction === 'horizontal' ? 'width' : 'height';
  return indexes.map((index) => {
    const child = split.children[index];
    const size = split.sizes[index];
    // A collapsed child keeps its collapsed size, and its own size waits in
    // `sizes` for when it expands.
    const collapsed = collapsedSizeOf(child);
    if (collapsed !== null)
      return { px: collapsed, weight: 1, min: collapsed, max: collapsed };
    return {
      px: isFixed(size) ? size.px : undefined,
      weight: isFixed(size) ? 1 : size,
      min: getMinimumSize(child, gap)[axis],
      max: getMaximumSize(child, gap)[axis],
    };
  });
}

/**
 * The ID of the separator before a child of a split: the ID of the split and
 * the index of the child. A split keeps the IDs of its separators when the
 * tree changes inside a child, for example when a new split wraps a pane, so
 * the view keeps each separator element and animates it from its old place.
 */
export const separatorId = (split: SplitNode, index: number): string =>
  `${split.id}:${index}`;

/** The indexes of the children of a split that take space. */
export function visibleChildren(split: SplitNode): number[] {
  return split.children.flatMap((child, index) =>
    hasVisiblePane(child) ? [index] : []
  );
}

/**
 * Divide `available` pixels among children with weights and minimum sizes
 * (see `divide`): each child gets its share of the weights, unless that share
 * is below its minimum size; then it gets its minimum, and the other children
 * share the rest by weight. When the minimum sizes do not fit, each child gets
 * a part in proportion to its minimum size.
 */
export function shareSpace(
  available: number,
  weights: readonly number[],
  mins: readonly number[]
): number[] {
  return divideSpace(
    available,
    weights.map((weight, index) => ({
      weight,
      min: mins[index],
      max: Infinity,
    }))
  );
}

/**
 * Resolve preferred sizes without overwriting them when a viewport temporarily
 * constrains space. Hidden panes take no space and have no geometry.
 */
export function computeLayout(
  layout: LayoutNode,
  width: number,
  height: number,
  gap = 8
): LayoutGeometry {
  if (
    ![width, height, gap].every((value) => Number.isFinite(value) && value >= 0)
  ) {
    throw new Error(
      'Layout dimensions and gap must be finite and non-negative'
    );
  }
  if (!hasVisiblePane(layout))
    return { panes: [], separators: [], corners: [] };
  const panes: LayoutGeometry['panes'][number][] = [];
  const separators: SeparatorGeometry[] = [];
  function visit(node: LayoutNode, rect: Rect): void {
    if (node.type === 'pane') {
      panes.push({ pane: node, rect });
      return;
    }
    if (node.type === 'stack') {
      const shown = shownPane(node);
      if (shown !== null) panes.push({ pane: shown, rect });
      return;
    }
    const visible = visibleChildren(node);
    if (visible.length === 1) {
      visit(node.children[visible[0]], rect);
      return;
    }
    const horizontal = node.direction === 'horizontal';
    const size = horizontal ? rect.width : rect.height;
    const actualGap = Math.min(gap, size / (visible.length - 1));
    const available = Math.max(0, size - actualGap * (visible.length - 1));
    const specs = childSpecs(node, visible, gap);
    const sizes = divideSpace(available, specs);
    const children: ChildExtent[] = visible.map((index, order) => ({
      index,
      size: sizes[order],
      min: specs[order].min,
      max: specs[order].max,
    }));
    // The start of each child along the axis of the split.
    const starts: number[] = [];
    let start = horizontal ? rect.x : rect.y;
    for (const size of sizes) {
      starts.push(start);
      start += size + actualGap;
    }
    // The separators of a split come before those of its children.
    visible.forEach((index, order) => {
      if (order === 0) return;
      const at = starts[order] - actualGap;
      separators.push({
        id: separatorId(node, index),
        split: node,
        index,
        rect: horizontal
          ? { x: at, y: rect.y, width: actualGap, height: rect.height }
          : { x: rect.x, y: at, width: rect.width, height: actualGap },
        container: rect,
        children,
      });
    });
    visible.forEach((index, order) =>
      visit(
        node.children[index],
        horizontal
          ? { ...rect, x: starts[order], width: sizes[order] }
          : { ...rect, y: starts[order], height: sizes[order] }
      )
    );
  }
  visit(layout, { x: 0, y: 0, width, height });
  const corners: LayoutGeometry['corners'][number][] = [];
  for (const horizontal of separators.filter(
    ({ split }) => split.direction === 'horizontal'
  )) {
    for (const vertical of separators.filter(
      ({ split }) => split.direction === 'vertical'
    )) {
      const x = horizontal.rect.x + horizontal.rect.width / 2;
      const y = vertical.rect.y + vertical.rect.height / 2;
      if (
        x >= vertical.rect.x - gap / 2 &&
        x <= vertical.rect.x + vertical.rect.width + gap / 2 &&
        y >= horizontal.rect.y - gap / 2 &&
        y <= horizontal.rect.y + horizontal.rect.height + gap / 2
      ) {
        const existing = corners.find(
          (corner) =>
            Math.abs(corner.x - x) < 0.01 && Math.abs(corner.y - y) < 0.01
        );
        if (existing === undefined) {
          corners.push({
            id: `${horizontal.id}:${vertical.id}`,
            x,
            y,
            separators: [horizontal, vertical],
          });
        } else {
          const index = corners.indexOf(existing);
          const touching = new Map(
            existing.separators.map((separator) => [separator.id, separator])
          );
          touching.set(horizontal.id, horizontal);
          touching.set(vertical.id, vertical);
          corners[index] = { ...existing, separators: [...touching.values()] };
        }
      }
    }
  }
  return { panes, separators, corners };
}

/** Choose the direction of a zoom exit, preferring an edge the pane already touches. */
export function getExitEdge(
  rect: Rect,
  width: number,
  height: number
): 'left' | 'right' | 'top' | 'bottom' {
  const distances = [
    ['left', rect.x],
    ['right', width - rect.x - rect.width],
    ['top', rect.y],
    ['bottom', height - rect.y - rect.height],
  ] as const;
  return [...distances].sort((a, b) => a[1] - b[1])[0][0];
}
