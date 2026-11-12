import type { FileDiffMetadata } from '@pierre/diffs';

export function newLineOf(fileDiff: FileDiffMetadata, line: number, side: 'old' | 'new'): number {
  if (side === 'new') return line;
  let offset = 0;
  for (const hunk of fileDiff.hunks) {
    const oldFirst = hunk.deletionCount === 0 ? hunk.deletionStart + 1 : hunk.deletionStart;
    const newFirst = hunk.additionCount === 0 ? hunk.additionStart + 1 : hunk.additionStart;
    if (line < oldFirst) break;
    offset = newFirst + hunk.additionCount - (oldFirst + hunk.deletionCount);
  }
  return line + offset;
}
