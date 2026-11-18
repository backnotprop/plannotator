import {
  isFixed,
  removePane,
  sameNodes,
  validateLayout,
  wrapPane,
} from '../model';
import type { ChildSize, LayoutNode, TreeModel } from '../types';

/**
 * The size of a new split that takes the place of several children: the sum
 * of their weights, or of their sizes in pixels when they all have one.
 */
function restSize(sizes: readonly ChildSize[]): ChildSize {
  const weights = sizes.filter((size) => !isFixed(size)) as number[];
  if (weights.length > 0)
    return weights.reduce((sum, weight) => sum + weight, 0);
  return {
    px: sizes.reduce<number>(
      (sum, size) => sum + (isFixed(size) ? size.px : 0),
      0
    ),
  };
}

/**
 * The prototype's model. Each split has two children, and a split can hold a
 * split of the same direction, so a row of three panes is a row in a row. A
 * split of a pane always puts a new split in its place, and a close gives the
 * space of the split to the sibling. A drag of a separator changes the two
 * subtrees beside it, so all the panes of a subtree change size together.
 */
export const binaryTree: TreeModel = {
  name: 'binary',
  validate(root) {
    validateLayout(root);
    const visit = (node: LayoutNode): void => {
      if (node.type !== 'split') return;
      if (node.children.length !== 2)
        throw new Error('A split of the binary model needs two children');
      node.children.forEach(visit);
    };
    visit(root);
  },
  normalize(root, nextId) {
    // A split of more than two children keeps its first child, and a new
    // split of the same direction takes the others.
    const nest = (node: LayoutNode): LayoutNode => {
      if (node.type !== 'split') return node;
      const children = node.children.map(nest);
      if (children.length === 2)
        return sameNodes(children, node.children)
          ? node
          : { ...node, children };
      const [size, ...sizes] = node.sizes;
      const rest = nest({
        type: 'split',
        id: nextId(),
        direction: node.direction,
        children: children.slice(1),
        sizes,
      });
      return {
        ...node,
        children: [children[0], rest],
        sizes: [size, restSize(sizes)],
      };
    };
    return nest(root);
  },
  split(root, targetId, pane, edge, nextId) {
    return wrapPane(root, targetId, pane, nextId(), edge);
  },
  remove(root, id) {
    return removePane(root, id, false);
  },
};
