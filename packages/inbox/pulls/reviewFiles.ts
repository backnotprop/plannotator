/**
 * A diff's files in the review rail's order. The rail is the review app's tree, and that tree keeps one node per path
 * segment, so a file can have no row in it: `docs` next to `docs/index.md`, or the two halves of a symlink turned
 * into a file (the same path twice). Every parsed file stays in the review: those the tree could not place are
 * `loose`, after the tree's, and the rail draws them as rows of their own.
 */

import { parseDiffToFiles, type DiffFile } from '@plannotator/core/diff-files';
import { buildDiffFileTree, getVisualFileOrder, type DiffFileTreeNode } from '@plannotator/ui/utils/diffFileTree';

export interface ReviewFiles {
  /** Every parsed file: the tree's in its order, then the loose ones. */
  files: DiffFile[];
  tree: DiffFileTreeNode<DiffFile>[];
  /** The files the tree could not place. */
  loose: DiffFile[];
  /**
   * The diff rebuilt for the viewer, which follows its order and draws one diff per path, the path's last. A path's
   * two halves stay in git's order, so that is the new file's half, whatever the tree kept.
   */
  patch: string;
}

export function reviewFiles(rawPatch: string): ReviewFiles {
  const parsed = parseDiffToFiles(rawPatch);
  const tree = buildDiffFileTree(parsed);
  const order = getVisualFileOrder(tree);
  const placed = new Set(order);
  const loose = parsed.filter((_, index) => !placed.has(index));
  const files = [...order.map((index) => parsed[index]!), ...loose];
  // Every chunk of a path at the tree's place for it, the rest after the tree.
  const inTree = new Set(order.map((index) => parsed[index]!.path));
  const forViewer = [...order.flatMap((index) => parsed.filter((file) => file.path === parsed[index]!.path)), ...loose.filter((file) => !inTree.has(file.path))];
  return { files, tree, loose, patch: forViewer.map((file) => (file.patch.endsWith('\n') ? file.patch : `${file.patch}\n`)).join('') };
}
