const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Walk every content line in a unified diff, yielding its prefix (+/-/ ),
 * the incremented old-side line number, and the incremented new-side line number.
 * Header and metadata lines are skipped.
 */
function* walkPatchLines(patch: string): Generator<{ prefix: string; content: string; oldLine: number; newLine: number }> {
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10) - 1;
      newLine = parseInt(hunkMatch[2], 10) - 1;
      continue;
    }
    const prefix = line[0];
    if (prefix === ' ') { oldLine++; newLine++; }
    else if (prefix === '-') { oldLine++; }
    else if (prefix === '+') { newLine++; }
    else continue; // header / metadata lines
    yield { prefix, content: line.substring(1), oldLine, newLine };
  }
}

/**
 * Extract line content from a unified diff patch by line number range and side.
 */
export function extractLinesFromPatch(
  patch: string,
  lineStart: number,
  lineEnd: number,
  side: 'old' | 'new'
): string {
  const result: string[] = [];
  for (const { prefix, content, oldLine, newLine } of walkPatchLines(patch)) {
    if (prefix === ' ') {
      const lineNum = side === 'old' ? oldLine : newLine;
      if (lineNum >= lineStart && lineNum <= lineEnd) result.push(content);
    } else if (prefix === '-' && side === 'old' && oldLine >= lineStart && oldLine <= lineEnd) {
      result.push(content);
    } else if (prefix === '+' && side === 'new' && newLine >= lineStart && newLine <= lineEnd) {
      result.push(content);
    }
  }
  return result.join('\n');
}

/**
 * Return the exact old/new line numbers that are changed in a unified diff.
 * Context lines are excluded.
 */
export function getChangedLineNumbersFromPatch(patch: string): {
  oldLines: Set<number>;
  newLines: Set<number>;
} {
  const oldLines = new Set<number>();
  const newLines = new Set<number>();
  for (const { prefix, oldLine, newLine } of walkPatchLines(patch)) {
    if (prefix === '-') oldLines.add(oldLine);
    else if (prefix === '+') newLines.add(newLine);
  }
  return { oldLines, newLines };
}
