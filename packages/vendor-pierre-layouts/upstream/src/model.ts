import type {
  ChildSize,
  Direction,
  Edge,
  LayoutNode,
  PaneNode,
  SplitNode,
  StackNode,
} from './types';

/** True for a child size in pixels, false for a weight. */
export const isFixed = (size: ChildSize): size is { readonly px: number } =>
  typeof size === 'object';

/** True when a value is a weight or a size in pixels that a split accepts. */
function isChildSize(size: unknown): size is ChildSize {
  if (typeof size === 'number') return Number.isFinite(size) && size > 0;
  if (size === null || typeof size !== 'object') return false;
  const keys = Object.keys(size);
  const px = (size as { px?: unknown }).px;
  return (
    keys.length === 1 &&
    keys[0] === 'px' &&
    typeof px === 'number' &&
    Number.isFinite(px) &&
    px >= 0
  );
}

/**
 * Reject malformed trees before they can create ambiguous pane identity or
 * geometry. A tree model adds the rules of its shape (`TreeModel.validate`).
 */
export function validateLayout(root: LayoutNode): void {
  const ids = new Set<string>();
  const objects = new Set<LayoutNode>();
  function visit(node: LayoutNode): void {
    if (node == null || typeof node !== 'object' || objects.has(node)) {
      throw new Error('Layout must be a tree without cycles or shared nodes');
    }
    objects.add(node);
    if (
      typeof node.id !== 'string' ||
      node.id.length === 0 ||
      ids.has(node.id)
    ) {
      throw new Error('Every layout node must have a unique, non-empty ID');
    }
    ids.add(node.id);
    if (node.type === 'pane') {
      for (const size of [node.minWidth, node.minHeight]) {
        if (size !== undefined && (!Number.isFinite(size) || size < 0)) {
          throw new Error('Pane minimum sizes must be finite and non-negative');
        }
      }
      for (const size of [node.maxWidth, node.maxHeight]) {
        if (size !== undefined && (Number.isNaN(size) || size < 0)) {
          throw new Error('Pane maximum sizes must be non-negative');
        }
      }
      if (node.hidden !== undefined && typeof node.hidden !== 'boolean') {
        throw new Error('Pane hidden must be a boolean');
      }
      validateCollapse(node);
    } else if (node.type === 'stack') {
      if (
        !Array.isArray(node.children) ||
        node.children.length < 2 ||
        !node.children.every((child) => child?.type === 'pane')
      ) {
        throw new Error('A stack needs at least two panes');
      }
      node.children.forEach(visit);
      if (!node.children.some(({ id }) => id === node.active)) {
        throw new Error('The active pane of a stack must be one of its panes');
      }
      if (node.children.some(({ collapsed }) => collapsed !== undefined)) {
        throw new Error(
          'A pane of a stack does not collapse: collapse the stack'
        );
      }
      validateCollapse(node);
    } else if (node.type === 'split') {
      if (node.direction !== 'horizontal' && node.direction !== 'vertical') {
        throw new Error('Split direction must be horizontal or vertical');
      }
      if (!Array.isArray(node.children) || node.children.length < 2) {
        throw new Error('A split needs at least two children');
      }
      if (
        !Array.isArray(node.sizes) ||
        node.sizes.length !== node.children.length ||
        !node.sizes.every(isChildSize)
      ) {
        throw new Error(
          'A split needs a positive weight or a size in pixels for each child'
        );
      }
      node.children.forEach(visit);
    } else {
      throw new Error('Unknown layout node type');
    }
  }
  visit(root);
  if (!hasVisiblePane(root)) {
    throw new Error('A layout needs at least one visible pane');
  }
}

function validateCollapse(node: PaneNode | StackNode): void {
  if (node.collapsed !== undefined && typeof node.collapsed !== 'boolean')
    throw new Error('Collapsed must be a boolean');
  const size = node.collapsedSize;
  if (size !== undefined && (!Number.isFinite(size) || size < 0))
    throw new Error('A collapsed size must be finite and non-negative');
}

/**
 * The size along its split of a collapsed pane or stack, or null for a node
 * that is not collapsed.
 */
export function collapsedSizeOf(node: LayoutNode): number | null {
  return node.type !== 'split' && node.collapsed === true
    ? (node.collapsedSize ?? 0)
    : null;
}

/** Collapse a pane or a stack, or expand it, in place. */
export function setNodeCollapsed(
  root: LayoutNode,
  id: string,
  collapsed: boolean
): LayoutNode {
  const next = replaceNode(root, id, (node) => {
    if (node.type === 'split') throw new Error(`Pane not found: ${id}`);
    if ((node.collapsed === true) === collapsed) return node;
    if (collapsed) return { ...node, collapsed: true };
    const { collapsed: _collapsed, ...expanded } = node;
    return expanded;
  });
  validateLayout(next);
  return next;
}

export function getPanes(root: LayoutNode): PaneNode[] {
  return root.type === 'pane' ? [root] : root.children.flatMap(getPanes);
}

export function hasVisiblePane(node: LayoutNode): boolean {
  return node.type === 'pane'
    ? node.hidden !== true
    : node.children.some(hasVisiblePane);
}

/**
 * The panes that show: hidden panes and the panes of a stack that are not
 * active are left out.
 */
export function shownPanes(node: LayoutNode): PaneNode[] {
  if (node.type === 'pane') return node.hidden === true ? [] : [node];
  if (node.type === 'stack') {
    const shown = shownPane(node);
    return shown === null ? [] : [shown];
  }
  return node.children.flatMap(shownPanes);
}

/**
 * The pane of a stack that shows: the active pane, or, when a caller hid it,
 * the first visible pane. Null when every pane of the stack is hidden.
 */
export function shownPane(stack: StackNode): PaneNode | null {
  const active = stack.children.find(({ id }) => id === stack.active);
  if (active !== undefined && active.hidden !== true) return active;
  return stack.children.find(({ hidden }) => hidden !== true) ?? null;
}

/** A node of the tree by its ID, or null. */
export function findNode(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (root.type === 'pane') return null;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found !== null) return found;
  }
  return null;
}

/** The stack that holds a pane, or null when the pane is not in a stack. */
export function stackOf(root: LayoutNode, id: string): StackNode | null {
  if (root.type === 'pane') return null;
  if (root.type === 'stack')
    return root.children.some((child) => child.id === id) ? root : null;
  for (const child of root.children) {
    const stack = stackOf(child, id);
    if (stack !== null) return stack;
  }
  return null;
}

/**
 * The node that takes the place of a pane in its split: its stack, or the
 * pane itself. A split or a move beside a pane in a stack goes beside the
 * whole stack.
 */
export function slotOf(root: LayoutNode, id: string): string {
  return stackOf(root, id)?.id ?? id;
}

/**
 * The tree that takes space: hidden panes are left out, and a split with one
 * visible child gives way to that child. A subtree with no hidden pane keeps
 * its identity. Null when no pane is visible.
 */
export function visibleTree(node: LayoutNode): LayoutNode | null {
  if (node.type === 'pane') return node.hidden === true ? null : node;
  if (node.type === 'stack') return hasVisiblePane(node) ? node : null;
  const children: LayoutNode[] = [];
  const sizes: ChildSize[] = [];
  node.children.forEach((child, index) => {
    const visible = visibleTree(child);
    if (visible === null) return;
    children.push(visible);
    sizes.push(node.sizes[index]);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return sameNodes(children, node.children)
    ? node
    : { ...node, children, sizes };
}

/** Hide a pane or show it again, in its place. */
export function setPaneHidden(
  root: LayoutNode,
  id: string,
  hidden: boolean
): LayoutNode {
  let next = replaceNode(root, id, (node) => {
    if (node.type !== 'pane') throw new Error(`Pane not found: ${id}`);
    if ((node.hidden === true) === hidden) return node;
    if (hidden) return { ...node, hidden: true };
    const { hidden: _hidden, ...shown } = node;
    return shown;
  });
  // A stack whose active pane hides shows its nearest visible pane.
  const stack = stackOf(next, id);
  if (hidden && stack !== null && stack.active === id) {
    const heir = nearestVisible(stack.children, id);
    if (heir !== null)
      next = replaceNode(next, stack.id, () => ({ ...stack, active: heir }));
  }
  validateLayout(next);
  return next;
}

/**
 * The visible pane nearest to a pane in a list of tabs: the next one, or the
 * one before it. Null when no other pane is visible.
 */
function nearestVisible(panes: readonly PaneNode[], id: string): string | null {
  const at = panes.findIndex((pane) => pane.id === id);
  const after = panes.slice(at + 1).find(({ hidden }) => hidden !== true);
  const before = panes
    .slice(0, Math.max(0, at))
    .reverse()
    .find(({ hidden }) => hidden !== true);
  return (after ?? before)?.id ?? null;
}

/** Show a pane of a stack. */
export function activatePane(root: LayoutNode, id: string): LayoutNode {
  const stack = stackOf(root, id);
  if (stack === null) throw new Error(`Pane not in a stack: ${id}`);
  if (stack.active === id) return root;
  return replaceNode(root, stack.id, () => ({ ...stack, active: id }));
}

/**
 * Move a pane of a stack to `index` among the panes of its stack: the index
 * in the order of the other panes, hidden ones included, from 0 to their
 * number. The pane becomes the active pane.
 */
export function moveTabTo(
  root: LayoutNode,
  id: string,
  index: number,
  activate = true
): LayoutNode {
  const stack = stackOf(root, id);
  if (stack === null) throw new Error(`Pane not in a stack: ${id}`);
  const tabs = stack.children.filter((child) => child.id !== id);
  const pane = stack.children.find((child) => child.id === id) as PaneNode;
  tabs.splice(clampIndex(index, tabs.length, tabs.length), 0, pane);
  const active = activate ? id : stack.active;
  if (sameNodes(tabs, stack.children) && stack.active === active) return root;
  return replaceNode(root, stack.id, () => ({
    ...stack,
    children: tabs,
    active,
  }));
}

/**
 * Add a pane to the stack of a target pane, at `index` among its tabs, or
 * after the target. A target that is not in a stack gets a new stack with
 * `stackId`, in its place. The new pane is the active pane.
 */
export function addToStack(
  root: LayoutNode,
  targetId: string,
  pane: PaneNode,
  stackId: string,
  index?: number,
  activate = true
): LayoutNode {
  const target = findNode(root, targetId);
  if (target === null || target.type === 'split')
    throw new Error(`Pane not found: ${targetId}`);
  const stack = target.type === 'stack' ? target : stackOf(root, targetId);
  if (stack === null) {
    // A collapsed target gives its collapse to the new stack.
    const { collapsed, collapsedSize, ...shown } = target as PaneNode;
    const tabs: PaneNode[] = [shown];
    tabs.splice(clampIndex(index, 1, 1), 0, pane);
    return replaceNode(root, targetId, () => ({
      type: 'stack',
      id: stackId,
      children: tabs,
      active: activate ? pane.id : shown.id,
      ...(collapsed === true ? { collapsed } : {}),
      ...(collapsedSize === undefined ? {} : { collapsedSize }),
    }));
  }
  const after =
    target.type === 'stack'
      ? stack.children.length
      : stack.children.findIndex(({ id }) => id === targetId) + 1;
  const tabs = [...stack.children];
  tabs.splice(clampIndex(index, after, tabs.length), 0, pane);
  return replaceNode(root, stack.id, () => ({
    ...stack,
    children: tabs,
    active: activate ? pane.id : stack.active,
  }));
}

const clampIndex = (
  index: number | undefined,
  fallback: number,
  length: number
): number =>
  index === undefined
    ? fallback
    : Math.min(length, Math.max(0, Math.round(index)));

/** True when two lists hold the same nodes in the same order. */
export function sameNodes(
  a: readonly LayoutNode[],
  b: readonly LayoutNode[]
): boolean {
  return a.length === b.length && a.every((node, index) => node === b[index]);
}

/** Replace a node immutably, preserving the identity of unaffected branches. */
export function replaceNode(
  root: LayoutNode,
  id: string,
  replace: (node: LayoutNode) => LayoutNode
): LayoutNode {
  if (root.id === id) return replace(root);
  if (root.type === 'pane') return root;
  if (root.type === 'stack') {
    const children = root.children.map((child) => {
      if (child.id !== id) return child;
      const next = replace(child);
      if (next.type !== 'pane')
        throw new Error('A stack holds panes only: replace the stack instead');
      return next;
    });
    return sameNodes(children, root.children) ? root : { ...root, children };
  }
  const children = root.children.map((child) =>
    replaceNode(child, id, replace)
  );
  return sameNodes(children, root.children) ? root : { ...root, children };
}

/** The split that holds a node as a direct child, or null for the root. */
export function parentOf(root: LayoutNode, id: string): SplitNode | null {
  if (root.type !== 'split') return null;
  for (const child of root.children) {
    if (child.id === id) return root;
    const parent = parentOf(child, id);
    if (parent !== null) return parent;
  }
  return null;
}

/** The direction of a split that puts a pane at an edge of another. */
export const directionOf = (edge: Edge): Direction =>
  edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';

/** Throw unless a tree holds the pane. */
export function requirePane(root: LayoutNode, id: string): void {
  if (!getPanes(root).some((pane) => pane.id === id))
    throw new Error(`Pane not found: ${id}`);
}

/**
 * Throw unless a tree holds a pane or a stack with the ID, outside a stack:
 * the target of a split or a move.
 */
export function requireSlot(root: LayoutNode, id: string): void {
  const node = findNode(root, id);
  if (node === null || node.type === 'split' || stackOf(root, id) !== null)
    throw new Error(`Pane not found: ${id}`);
}

/**
 * Put a new split with `splitId` in the place of a target pane or stack. The
 * split holds the target and the new pane, each with half of the space.
 */
export function wrapPane(
  root: LayoutNode,
  targetId: string,
  pane: PaneNode,
  splitId: string,
  edge: Edge
): LayoutNode {
  requireSlot(root, targetId);
  const before = edge === 'left' || edge === 'top';
  return replaceNode(root, targetId, (target) => ({
    type: 'split',
    id: splitId,
    direction: directionOf(edge),
    children: before ? [pane, target] : [target, pane],
    sizes: [0.5, 0.5],
  }));
}

/**
 * Remove a pane. A visible pane gives its size to the nearest visible child
 * before it in its split, or after it when there is none, so that the other
 * children keep their size. A hidden pane takes no space, so its size goes
 * away with it. A split with one child left gives way to that child. With
 * `join`, a child split of the same direction as its new parent joins it (see
 * `joinChildren`).
 */
export function removePane(
  root: LayoutNode,
  id: string,
  join: boolean
): LayoutNode | null {
  if (root.type === 'pane') return root.id === id ? null : root;
  if (root.type === 'stack') return removeTab(root, id);
  const children: LayoutNode[] = [];
  const sizes: ChildSize[] = [];
  // The place of the removed child among the children that stay, its size,
  // and whether it took space.
  let removed: { at: number; size: ChildSize; visible: boolean } | null = null;
  for (let index = 0; index < root.children.length; index++) {
    const child = root.children[index];
    const next = removePane(child, id, join);
    if (next === null) {
      removed = {
        at: children.length,
        size: root.sizes[index],
        visible: hasVisiblePane(child),
      };
    } else {
      children.push(next);
      sizes.push(root.sizes[index]);
    }
  }
  if (removed === null && sameNodes(children, root.children)) return root;
  if (children.length === 0) return null;
  // A child with a size in pixels gives its space to the weighted children
  // as a group. A weighted child gives its weight to the nearest weighted
  // child that takes space.
  const size = removed?.size;
  if (removed?.visible === true && typeof size === 'number') {
    const heirs = children.map(
      (child, index) => hasVisiblePane(child) && !isFixed(sizes[index])
    );
    const before = heirs.slice(0, removed.at).lastIndexOf(true);
    const after = heirs.indexOf(true, removed.at);
    const heir = before !== -1 ? before : after;
    if (heir !== -1) sizes[heir] = (sizes[heir] as number) + size;
  }
  if (children.length === 1) return children[0];
  return join
    ? { ...root, ...joinChildren(root.direction, children, sizes) }
    : { ...root, children, sizes };
}

/**
 * Remove a pane from a stack. When the active pane goes, its nearest visible
 * pane shows. A stack with one pane left gives way to that pane.
 */
function removeTab(stack: StackNode, id: string): LayoutNode | null {
  if (!stack.children.some((child) => child.id === id)) return stack;
  const children = stack.children.filter((child) => child.id !== id);
  if (children.length === 0) return null;
  if (children.length === 1) {
    // The last pane takes the collapse of its stack.
    const [last] = children;
    if (stack.collapsed !== true) return last;
    return {
      ...last,
      collapsed: true,
      collapsedSize: stack.collapsedSize ?? last.collapsedSize ?? 0,
    };
  }
  const active =
    stack.active === id
      ? (nearestVisible(stack.children, id) ?? children[0].id)
      : stack.active;
  return { ...stack, children, active };
}

/**
 * The children and sizes of a split, where each child that is a split of the
 * same direction joins the split in its place. The children of a joined split
 * share the size that it had, in proportion to their own sizes.
 */
export function joinChildren(
  direction: Direction,
  children: readonly LayoutNode[],
  sizes: readonly ChildSize[]
): { children: LayoutNode[]; sizes: ChildSize[] } {
  const joined: { children: LayoutNode[]; sizes: ChildSize[] } = {
    children: [],
    sizes: [],
  };
  children.forEach((child, index) => {
    if (child.type === 'split' && child.direction === direction) {
      joined.children.push(...child.children);
      joined.sizes.push(...shareSlot(sizes[index], child.sizes));
    } else {
      joined.children.push(child);
      joined.sizes.push(sizes[index]);
    }
  });
  return joined;
}

/**
 * The sizes of the children of a split that joins its parent in the place
 * of one child. Sizes in pixels stay. In a weighted place, the weighted
 * children share its weight. In a place in pixels, the weighted children
 * take sizes in pixels from what the others leave of it. The separators of
 * the joined children are not counted, so such a place grows by their gaps.
 */
function shareSlot(slot: ChildSize, sizes: readonly ChildSize[]): ChildSize[] {
  const weights = sizes.filter((size) => !isFixed(size)) as number[];
  const total = weights.reduce((sum, size) => sum + size, 0);
  if (!isFixed(slot))
    return sizes.map((size) => (isFixed(size) ? size : (slot * size) / total));
  const pixels = sizes.reduce<number>(
    (sum, size) => sum + (isFixed(size) ? size.px : 0),
    0
  );
  const rest = Math.max(0, slot.px - pixels);
  return sizes.map((size) =>
    isFixed(size) ? size : { px: (rest * size) / total }
  );
}

/** Half of a child size: half of its weight, or of its size in pixels. */
export const halfOf = (size: ChildSize): ChildSize =>
  isFixed(size) ? { px: size.px / 2 } : size / 2;

export function swapPanes(
  root: LayoutNode,
  firstId: string,
  secondId: string
): LayoutNode {
  const panes = getPanes(root);
  const first = panes.find(({ id }) => id === firstId);
  const second = panes.find(({ id }) => id === secondId);
  if (first === undefined || second === undefined)
    throw new Error('Pane not found');
  const firstPane = first;
  const secondPane = second;
  const swapId = (id: string): string =>
    id === firstId ? secondId : id === secondId ? firstId : id;
  function swapPane(node: PaneNode): PaneNode {
    return node.id === firstId
      ? secondPane
      : node.id === secondId
        ? firstPane
        : node;
  }
  function swap(node: LayoutNode): LayoutNode {
    if (node.type === 'pane') return swapPane(node);
    if (node.type === 'stack')
      return {
        ...node,
        children: node.children.map(swapPane),
        active: swapId(node.active),
      };
    return { ...node, children: node.children.map(swap) };
  }
  return swap(root);
}

/** A node of the saved form of version 1, where each split had two children. */
export type BinaryLayoutNode =
  | PaneNode
  | {
      readonly type: 'split';
      readonly id: string;
      readonly direction: Direction;
      /** The share of the first child. */
      readonly ratio: number;
      readonly first: BinaryLayoutNode;
      readonly second: BinaryLayoutNode;
    };

/** Convert a tree of the saved form of version 1. The shape stays the same. */
export function fromBinaryLayout(node: BinaryLayoutNode): LayoutNode {
  if (node.type === 'pane') return node;
  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    children: [fromBinaryLayout(node.first), fromBinaryLayout(node.second)],
    sizes: [node.ratio, 1 - node.ratio],
  };
}
