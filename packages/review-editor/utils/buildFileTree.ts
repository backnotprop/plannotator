/**
 * The review's file-tree builder now lives in @plannotator/ui so hosts can embed
 * the same tree (`@plannotator/ui/components/DiffFileTree`). This module keeps
 * the review's historical names and binds the node type to the review's
 * DiffFile, so every review call site is unchanged.
 */
import type { DiffFile } from '../types';
import type { DiffFileTreeNode } from '@plannotator/ui/utils/diffFileTree';

export {
  buildDiffFileTree as buildFileTree,
  getAncestorPaths,
  getVisualFileOrder,
  getAllFolderPaths,
} from '@plannotator/ui/utils/diffFileTree';

export type FileTreeNode = DiffFileTreeNode<DiffFile>;
