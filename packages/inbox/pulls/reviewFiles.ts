/** The rail's tree keeps one node per path segment, so some files (`docs` beside `docs/index.md`, a symlink's two halves) get no row: those are `loose` and drawn as rows of their own after the tree's. */

import { parseDiffToFiles, type DiffFile } from '@plannotator/core/diff-files';
import { buildDiffFileTree, getVisualFileOrder, type DiffFileTreeNode } from '@plannotator/ui/utils/diffFileTree';

export interface ReviewFiles {
  files: DiffFile[];
  tree: DiffFileTreeNode<DiffFile>[];
  loose: DiffFile[];
  patch: string;
}

export function reviewFiles(rawPatch: string): ReviewFiles {
  const parsed = parseDiffToFiles(rawPatch);
  const tree = buildDiffFileTree(parsed);
  const order = getVisualFileOrder(tree);
  const placed = new Set(order);
  const loose = parsed.filter((_, index) => !placed.has(index));
  const files = [...order.map((index) => parsed[index]!), ...loose];
  const inTree = new Set(order.map((index) => parsed[index]!.path));
  const byPath = new Map<string, DiffFile[]>();
  for (const file of parsed) byPath.set(file.path, [...(byPath.get(file.path) ?? []), file]);
  const forViewer = [...order.flatMap((index) => byPath.get(parsed[index]!.path)!), ...loose.filter((file) => !inTree.has(file.path))];
  return { files, tree, loose, patch: forViewer.map((file) => (file.patch.endsWith('\n') ? file.patch : `${file.patch}\n`)).join('') };
}
