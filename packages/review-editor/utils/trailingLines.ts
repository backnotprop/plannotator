export function linesAfterLastHunk(hunks: readonly { additionStart: number; additionCount: number }[], newContent: string): number {
  const last = hunks.at(-1);
  if (!last) return 0;
  const end = last.additionCount > 0 ? last.additionStart + last.additionCount - 1 : last.additionStart;
  const lines = newContent === '' ? 0 : newContent.split('\n').length - (newContent.endsWith('\n') ? 1 : 0);
  return Math.max(0, lines - end);
}

export function unmodifiedLinesLabel(count: number): string {
  return `${count} unmodified line${count === 1 ? '' : 's'}`;
}
