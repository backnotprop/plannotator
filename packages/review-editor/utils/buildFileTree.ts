import type { DiffFile } from '../types';
import type { DiffFileTreeNode } from '@plannotator/ui/utils/diffFileTree';

export {
  buildDiffFileTree as buildFileTree,
  getAncestorPaths,
  getVisualFileOrder,
  getAllFolderPaths,
} from '@plannotator/ui/utils/diffFileTree';

export type FileTreeNode = DiffFileTreeNode<DiffFile>;
