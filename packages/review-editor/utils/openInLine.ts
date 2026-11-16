import type { SelectedLineRange } from '@plannotator/ui/types';

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The line of the file on disk that code review's "Open in" opens at.
 *  - Lines picked on the new side (a selection, or the picked comment's lines):
 *    their first line.
 *  - Lines picked on the old side (removed lines): where they were, in the new
 *    file, found by walking the patch's hunks.
 *  - Nothing picked: the file's first change.
 * Undefined when the patch names no change (the file opens at its top).
 */
export function openInLineForDiff(
  patch: string,
  range?: Pick<SelectedLineRange, 'start'> & { side?: SelectedLineRange['side'] } | null,
): number | undefined {
  if (range && range.side === 'additions' && Number.isSafeInteger(range.start) && range.start > 0) {
    return range.start;
  }
  const oldTarget = range && range.side === 'deletions' ? range.start : null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let firstChange: number | undefined;
  for (const text of patch.split('\n')) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const mark = text[0];
    if (mark === ' ') {
      if (oldTarget === oldLine) return Math.max(1, newLine);
      oldLine++;
      newLine++;
    } else if (mark === '+') {
      firstChange ??= Math.max(1, newLine);
      newLine++;
    } else if (mark === '-') {
      if (oldTarget === oldLine) return Math.max(1, newLine);
      firstChange ??= Math.max(1, newLine);
      oldLine++;
    } else if (mark !== '\\') {
      // A line that is not part of a hunk (the next file's `diff --git`): stop
      // counting until the next hunk header.
      inHunk = false;
    }
  }
  return firstChange;
}
