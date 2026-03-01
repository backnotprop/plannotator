/** Formats a line range as "Line 5" (single) or "Lines 5-12" (multi-line) */
export function formatLineRange(start: number, end: number): string {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return lo === hi ? `Line ${lo}` : `Lines ${lo}-${hi}`;
}
