/**
 * Extract line content from a unified diff patch by line number range and side.
 */
export function extractLinesFromPatch(
  patch: string,
  lineStart: number,
  lineEnd: number,
  side: 'old' | 'new'
): string {
  const lines = patch.split('\n');
  const result: string[] = [];

  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10) - 1;
      newLine = parseInt(hunkMatch[2], 10) - 1;
      continue;
    }

    // Skip diff headers
    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }

    const prefix = line[0];
    const content = line.substring(1);

    if (prefix === ' ') {
      // Context line — exists on both sides
      oldLine++;
      newLine++;
      const lineNum = side === 'old' ? oldLine : newLine;
      if (lineNum >= lineStart && lineNum <= lineEnd) {
        result.push(content);
      }
    } else if (prefix === '-') {
      // Deletion — old side only
      oldLine++;
      if (side === 'old' && oldLine >= lineStart && oldLine <= lineEnd) {
        result.push(content);
      }
    } else if (prefix === '+') {
      // Addition — new side only
      newLine++;
      if (side === 'new' && newLine >= lineStart && newLine <= lineEnd) {
        result.push(content);
      }
    }
  }

  return result.join('\n');
}

/** Return true only when the complete source range is represented by one diff hunk. */
export function isLineRangeInPatch(
  patch: string,
  lineStart: number,
  lineEnd: number,
  side: 'old' | 'new',
): boolean {
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
    return false;
  }
  for (const line of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(side === 'old' ? match[1] : match[3]);
    const count = Number((side === 'old' ? match[2] : match[4]) ?? '1');
    if (count === 0) continue;
    if (lineStart >= start && lineEnd <= start + count - 1) return true;
  }
  return false;
}

/**
 * Slice a 1-based, inclusive line range out of whole file contents.
 *
 * The patch-free counterpart of `extractLinesFromPatch`, for surfaces that
 * hold the file rather than a diff of it (the full-file viewer) and for lines
 * that exist in the file but not in any hunk (expanded diff context).
 */
export function extractLinesFromContent(
  content: string,
  lineStart: number,
  lineEnd: number,
): string {
  if (!content) return '';
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) return '';
  if (lineStart < 1 || lineEnd < lineStart) return '';
  return content
    .split('\n')
    .slice(lineStart - 1, lineEnd)
    .join('\n');
}

/**
 * The snippet an annotation should carry, preferring the patch and falling
 * back to file contents.
 *
 * Why the fallback exists: `extractLinesFromPatch` only walks hunk lines, so
 * annotating expanded context (or any line of a full-file view) produced an
 * EMPTY `originalCode`. The annotation then reached the agent as a bare line
 * number with no code attached, which is exactly the case where the agent
 * most needs the code — the lines are not in the diff it was given.
 *
 * Only the new side falls back: `fileContent` is the working tree, so using
 * it for an old-side range would quote the wrong text. An old-side range with
 * no hunk coverage correctly yields nothing.
 */
export function resolveAnnotationSnippet(
  patch: string,
  fileContent: string | undefined,
  lineStart: number,
  lineEnd: number,
  side: 'old' | 'new',
): string {
  const fromPatch = patch ? extractLinesFromPatch(patch, lineStart, lineEnd, side) : '';
  if (fromPatch) return fromPatch;
  if (side !== 'new' || !fileContent) return fromPatch;
  return extractLinesFromContent(fileContent, lineStart, lineEnd);
}
