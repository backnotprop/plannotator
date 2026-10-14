/**
 * The file tree split by kind (approved design record "review-file-kinds"):
 * when a change holds two or more kinds, the tree becomes one block per kind
 * (Code, Tests, Generated), each block today's folder tree over its own files.
 * One builder feeds the tree's rows, its j/k order and the all-files order, so
 * the three never disagree.
 */
import { groupByFileKind, type FileKind } from '@plannotator/core/file-kind';
import type { DiffFile } from '../types';
import { buildFileTree, getVisualFileOrder, type FileTreeNode } from './buildFileTree';

export interface FileKindBlock {
  kind: FileKind;
  /** The block's folder tree. File nodes carry their index in the FULL files
   *  array; folder paths are scoped by `kindFolderPath`, so the same folder in
   *  two blocks opens and closes on its own. */
  tree: FileTreeNode[];
  /** Paths of the block's files, in the files array's order. */
  paths: string[];
  additions: number;
  deletions: number;
}

/** A folder path scoped to its block. Also applied to the active file's path,
 *  so the expansion hook's "open the active file's ancestors" rule still holds. */
export function kindFolderPath(kind: FileKind, path: string): string {
  return `${kind}:${path}`;
}

function remap(nodes: FileTreeNode[], kind: FileKind, indexes: number[]): FileTreeNode[] {
  return nodes.map((node) =>
    node.type === 'file'
      ? { ...node, fileIndex: indexes[node.fileIndex!] }
      : { ...node, path: kindFolderPath(kind, node.path), children: node.children && remap(node.children, kind, indexes) },
  );
}

/** The kind blocks, or null when the change holds a single kind (the tree is
 *  then today's tree, unchanged). */
export function buildFileKindBlocks(files: readonly DiffFile[], generated?: ReadonlySet<string>): FileKindBlock[] | null {
  const indexed = files.map((file, index) => ({ file, index }));
  const groups = groupByFileKind(indexed, (item) => item.file.path, generated);
  if (groups.length < 2) return null;
  return groups.map(({ kind, items }) => ({
    kind,
    tree: remap(buildFileTree(items.map((item) => item.file)), kind, items.map((item) => item.index)),
    paths: items.map((item) => item.file.path),
    additions: items.reduce((sum, item) => sum + item.file.additions, 0),
    deletions: items.reduce((sum, item) => sum + item.file.deletions, 0),
  }));
}

/** File indexes in the order the kind-grouped tree shows them: the blocks in
 *  kind order, each in tree order. Today's tree order with a single kind. */
export function getFileKindOrder(files: readonly DiffFile[], generated?: ReadonlySet<string>): number[] {
  const blocks = buildFileKindBlocks(files, generated);
  return getVisualFileOrder(blocks ? blocks.flatMap((block) => block.tree) : buildFileTree(files));
}
