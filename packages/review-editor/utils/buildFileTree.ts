/**
 * The review's file-tree builder now lives in @plannotator/ui so hosts can embed
 * the same tree (`@plannotator/ui/components/DiffFileTree`). This module keeps
 * the review's historical names and binds the node type to the review's
 * DiffFile, so every review call site is unchanged.
 */
import type { DiffFile } from '../types';
import { buildDiffFileTree, type DiffFileTreeNode } from '@plannotator/ui/utils/diffFileTree';

export {
  getAncestorPaths,
  getVisualFileOrder,
  getAllFolderPaths,
} from '@plannotator/ui/utils/diffFileTree';

export type FileTreeNode = DiffFileTreeNode<DiffFile>;

/** Keep node indexes in the original diff so selection and progress keep working. */
export function buildFileTree(files: readonly DiffFile[], visible?: ReadonlySet<string>): FileTreeNode[] {
  if (!visible) return buildDiffFileTree(files);
  const indexes: number[] = [];
  const filtered = files.filter((file, index) => {
    if (!visible.has(file.path)) return false;
    indexes.push(index);
    return true;
  });
  const tree = buildDiffFileTree(filtered);
  const restoreIndexes = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.fileIndex !== undefined) node.fileIndex = indexes[node.fileIndex];
      if (node.children) restoreIndexes(node.children);
    }
  };
  restoreIndexes(tree);
  return tree;
}
