/** Formats a line range as "Line 5" (single) or "Lines 5-12" (multi-line) */
export function formatLineRange(start: number, end: number): string {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return lo === hi ? `Line ${lo}` : `Lines ${lo}-${hi}`;
}

/** Formats a token selection as "Line 5: `token`" */
export function formatTokenContext(tokenSelection: {
  anchor: { lineNumber: number };
  fullText: string;
}): string {
  const display = tokenSelection.fullText.length > 30
    ? tokenSelection.fullText.slice(0, 27) + '...'
    : tokenSelection.fullText;
  return `Line ${tokenSelection.anchor.lineNumber}: \`${display}\``;
}
