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
