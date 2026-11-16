import {
  directionOf,
  halfOf,
  joinChildren,
  parentOf,
  removePane,
  replaceNode,
  requireSlot,
  sameNodes,
  validateLayout,
  wrapPane,
} from '../model';
import type { Direction, LayoutNode, TreeModel } from '../types';

/**
 * A split holds two or more children, and no child is a split of the same
 * direction, so each visual row or column is one node. A split of a pane in a
 * row, to its left or right, adds the new pane to the row. A close gives the
 * space of a pane to its neighbour. A drag of a separator changes only the two
 * children beside it, and changes the next ones only when a child reaches its
 * minimum size.
 */
export const naryTree: TreeModel = {
  name: 'n-ary',
  validate(root) {
    validateLayout(root);
    const visit = (node: LayoutNode, parent: Direction | null): void => {
      if (node.type !== 'split') return;
      if (node.direction === parent)
        throw new Error(
          'A split of the n-ary model cannot hold a split of the same direction'
        );
      for (const child of node.children) visit(child, node.direction);
    };
    visit(root, null);
  },
  normalize(root) {
    const flatten = (node: LayoutNode): LayoutNode => {
      if (node.type !== 'split') return node;
      const joined = joinChildren(
        node.direction,
        node.children.map(flatten),
        node.sizes
      );
      return sameNodes(joined.children, node.children)
        ? node
        : { ...node, ...joined };
    };
    return flatten(root);
  },
  // In a split of the edge's direction, the new pane goes beside the target
  // and takes half of its size.
  split(root, targetId, pane, edge, nextId) {
    requireSlot(root, targetId);
    const parent = parentOf(root, targetId);
    if (parent === null || parent.direction !== directionOf(edge))
      return wrapPane(root, targetId, pane, nextId(), edge);
    const index = parent.children.findIndex(({ id }) => id === targetId);
    const half = halfOf(parent.sizes[index]);
    const at = edge === 'left' || edge === 'top' ? index : index + 1;
    return replaceNode(root, parent.id, () => ({
      ...parent,
      children: [
        ...parent.children.slice(0, at),
        pane,
        ...parent.children.slice(at),
      ],
      sizes: [
        ...parent.sizes.slice(0, index),
        half,
        half,
        ...parent.sizes.slice(index + 1),
      ],
    }));
  },
  remove(root, id) {
    return removePane(root, id, true);
  },
};
