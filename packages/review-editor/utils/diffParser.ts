import { parseDiffFilePathLines, parseDiffGitHeader } from '@plannotator/shared/diff-paths';
import type { DiffFile } from '../types';

function splitDiffChunks(rawPatch: string): string[] {
  const matches = [...rawPatch.matchAll(/^diff --git /gm)];
  if (matches.length === 0) return [];

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? rawPatch.length;
    return rawPatch.slice(start, end);
  });
}

export function parseDiffToFiles(rawPatch: string): DiffFile[] {
  const files: DiffFile[] = [];

  for (const chunk of splitDiffChunks(rawPatch)) {
    const lines = chunk.split('\n');
    const fromFileLines = parseDiffFilePathLines(lines);
    const fromHeader = parseDiffGitHeader(lines[0] ?? '');
    const oldPath = fromFileLines.oldPath ?? fromFileLines.newPath ?? fromHeader.oldPath;
    const newPath = fromFileLines.newPath ?? fromFileLines.oldPath ?? fromHeader.newPath;
    if (!oldPath || !newPath) continue;

    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }

    files.push({
      path: newPath,
      oldPath: oldPath !== newPath ? oldPath : undefined,
      patch: chunk,
      additions,
      deletions,
    });
  }

  return files;
}
