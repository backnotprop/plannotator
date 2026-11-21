import type { FileDiffMetadata } from '@pierre/diffs';

/** `line`'s number on the new side, for a line outside every hunk (where both sides read the same). */
export function newLineOf(fileDiff: FileDiffMetadata, line: number, side: 'old' | 'new'): number {
  if (side === 'new') return line;
  let offset = 0;
  for (const hunk of fileDiff.hunks) {
    // A side with no lines (`-5,0 +6,3`, only under -U0) names the line before the hunk, as git writes it.
    const oldFirst = hunk.deletionCount === 0 ? hunk.deletionStart + 1 : hunk.deletionStart;
    const newFirst = hunk.additionCount === 0 ? hunk.additionStart + 1 : hunk.additionStart;
    if (line < oldFirst) break;
    offset = newFirst + hunk.additionCount - (oldFirst + hunk.deletionCount);
  }
  return line + offset;
}
