import { groupByFileKind, type FileKind } from '@plannotator/core/file-kind';
import type { DiffFile } from '../types';
import { buildFileTree, getVisualFileOrder, type FileTreeNode } from './buildFileTree';

export interface FileKindBlock {
  kind: FileKind;
  tree: FileTreeNode[];
  paths: string[];
  additions: number;
  deletions: number;
}

export function kindFolderPath(kind: FileKind, path: string): string {
  return `${kind}:${path}`;
}

export function folderDisplayPath(path: string): string {
  const match = /^(code|test|generated):/.exec(path);
  return match ? path.slice(match[0].length) : path;
}

function remap(nodes: FileTreeNode[], kind: FileKind, indexes: number[]): FileTreeNode[] {
  return nodes.map((node) =>
    node.type === 'file'
      ? { ...node, fileIndex: indexes[node.fileIndex!] }
      : { ...node, path: kindFolderPath(kind, node.path), children: node.children && remap(node.children, kind, indexes) },
  );
}

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

export function getFileKindOrder(files: readonly DiffFile[], generated?: ReadonlySet<string>): number[] {
  const blocks = buildFileKindBlocks(files, generated);
  return getVisualFileOrder(blocks ? blocks.flatMap((block) => block.tree) : buildFileTree(files));
}
