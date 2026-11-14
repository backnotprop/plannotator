import type { SinceBaseSections } from '@plannotator/shared/types';
import type { DiffFile } from '../types';
import { buildFileTree, getVisualFileOrder, type FileTreeNode } from './buildFileTree';
import { remapBlockTree } from './fileKindTree';

export type FileStatusGroup = 'committed' | 'staged' | 'unstaged' | 'untracked';

export const FILE_STATUS_GROUPS: readonly FileStatusGroup[] = ['committed', 'staged', 'unstaged', 'untracked'];

export const FILE_STATUS_LABELS: Record<FileStatusGroup, string> = {
  committed: 'Committed',
  staged: 'Staged',
  unstaged: 'Unstaged',
  untracked: 'Untracked',
};

export const FILE_STATUS_COVERS: Record<FileStatusGroup, string> = {
  committed: 'Committed on this branch since the base, with nothing left to commit',
  staged: 'Changes added with git add, ready to commit',
  unstaged: 'Changes in the working tree that are not staged',
  untracked: 'New files git does not track yet',
};

export interface FileStatusBlock {
  status: FileStatusGroup;
  tree: FileTreeNode[];
  paths: string[];
  additions: number;
  deletions: number;
}

export function fileStatusGroup(
  file: Pick<DiffFile, 'path' | 'status'>,
  sections: SinceBaseSections,
  stagedFiles: ReadonlySet<string>,
): FileStatusGroup {
  const entry = sections.files[file.path];
  const staged = stagedFiles.has(file.path);
  const group = entry?.group ?? 'committed';
  if (group === 'committed') return 'committed';
  if (group === 'untracked') return staged ? 'staged' : 'untracked';
  if (!staged && (entry?.staged ?? false) && file.status === 'added') return 'untracked';
  return staged ? 'staged' : 'unstaged';
}

export function buildFileStatusBlocks(
  files: readonly DiffFile[],
  sections: SinceBaseSections,
  stagedFiles: ReadonlySet<string>,
): FileStatusBlock[] {
  const grouped = new Map<FileStatusGroup, { file: DiffFile; index: number }[]>();
  files.forEach((file, index) => {
    const status = fileStatusGroup(file, sections, stagedFiles);
    const bucket = grouped.get(status);
    if (bucket) bucket.push({ file, index });
    else grouped.set(status, [{ file, index }]);
  });
  return FILE_STATUS_GROUPS.filter((status) => grouped.has(status)).map((status) => {
    const items = grouped.get(status)!;
    return {
      status,
      tree: remapBlockTree(buildFileTree(items.map((item) => item.file)), status, items.map((item) => item.index)),
      paths: items.map((item) => item.file.path),
      additions: items.reduce((sum, item) => sum + item.file.additions, 0),
      deletions: items.reduce((sum, item) => sum + item.file.deletions, 0),
    };
  });
}

export function getFileStatusOrder(files: readonly DiffFile[], sections: SinceBaseSections, stagedFiles: ReadonlySet<string>): number[] {
  return getVisualFileOrder(buildFileStatusBlocks(files, sections, stagedFiles).flatMap((block) => block.tree));
}
