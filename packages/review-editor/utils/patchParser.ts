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

/**
 * Return old/new line numbers for hunks that contain BOTH additions and
 * deletions (i.e. modifications, not pure adds/removes).  These are the lines
 * where toggling to the opposite single-file view would reveal a counterpart
 * change.
 */
export function getModifiedHunkLineNumbers(patch: string): {
  oldLines: Set<number>;
  newLines: Set<number>;
} {
  const oldLinesResult = new Set<number>();
  const newLinesResult = new Set<number>();

  let hunkOldLines: number[] = [];
  let hunkNewLines: number[] = [];

  function flushHunk() {
    if (hunkOldLines.length > 0 && hunkNewLines.length > 0) {
      for (const n of hunkOldLines) oldLinesResult.add(n);
      for (const n of hunkNewLines) newLinesResult.add(n);
    }
    hunkOldLines = [];
    hunkNewLines = [];
  }

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split('\n')) {
    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      flushHunk();
      oldLine = parseInt(hunkMatch[1], 10) - 1;
      newLine = parseInt(hunkMatch[2], 10) - 1;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const prefix = line[0];
    if (prefix === ' ') { oldLine++; newLine++; }
    else if (prefix === '-') { oldLine++; hunkOldLines.push(oldLine); }
    else if (prefix === '+') { newLine++; hunkNewLines.push(newLine); }
  }
  flushHunk();

  return { oldLines: oldLinesResult, newLines: newLinesResult };
}
