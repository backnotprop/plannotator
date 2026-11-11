/**
 * The lines a file keeps after its diff's last hunk, from the file's whole new text: what Pierre's
 * trailing row counts once it has the whole file ("N unmodified lines").
 */
export function linesAfterLastHunk(hunks: readonly { additionStart: number; additionCount: number }[], newContent: string): number {
  const last = hunks.at(-1);
  if (!last) return 0;
  const end = last.additionCount > 0 ? last.additionStart + last.additionCount - 1 : last.additionStart;
  const lines = newContent === '' ? 0 : newContent.split('\n').length - (newContent.endsWith('\n') ? 1 : 0);
  return Math.max(0, lines - end);
}

/**
 * Pierre's own words for a closed run of lines (DiffHunksRenderer `getModifiedLinesString`, @pierre/diffs 1.5.2): check
 * them again on an upgrade, so this row reads as Pierre's once the file is read.
 */
export function unmodifiedLinesLabel(count: number): string {
  return `${count} unmodified line${count === 1 ? '' : 's'}`;
}
