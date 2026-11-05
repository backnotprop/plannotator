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
  /** The diff rebuilt in `files`' order, which the diffs below the rail follow. */
  patch: string;
}

export function reviewFiles(rawPatch: string): ReviewFiles {
  const parsed = parseDiffToFiles(rawPatch);
  const tree = buildDiffFileTree(parsed);
  const order = getVisualFileOrder(tree);
  const placed = new Set(order);
  const loose = parsed.filter((_, index) => !placed.has(index));
  const files = [...order.map((index) => parsed[index]!), ...loose];
  return { files, tree, loose, patch: files.map((file) => (file.patch.endsWith('\n') ? file.patch : `${file.patch}\n`)).join('') };
}
