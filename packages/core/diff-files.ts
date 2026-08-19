/**
 * Unified diff → per-file records. The one splitter/path resolver shared by
 * the review app, the guide chain, and the portable-format helpers
 * (`listGuidePatchFiles`, language preload detection), so every consumer
 * agrees on which files a patch contains.
 *
 * Browser-safe and dependency-free.
 */

import { parseDiffFilePathLines, parseDiffGitHeader, parseDiffMetadataPathLines } from "./diff-paths";

/**
 * Change type derived from the diff's metadata lines. 'modified' is the
 * default and is deliberately NOT decorated in the UI (mirroring Pierre's
 * diffshub: most files are modifications, so only A/D/R stand out).
 */
export type DiffFileStatus = "added" | "deleted" | "renamed" | "modified";

/** One file of a unified diff, as the guide and the review app both consume it. */
export interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
  status: DiffFileStatus;
}

function splitDiffChunks(rawPatch: string): string[] {
  const matches = [...rawPatch.matchAll(/^diff --git /gm)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? rawPatch.length;
    return rawPatch.slice(start, end);
  });
}

/**
 * Change type from the chunk's git metadata lines. Scans only the extended
 * header (everything before the first hunk/--- line) so file content that
 * happens to contain "rename from" etc. can't misclassify.
 */
function deriveStatus(lines: string[], oldPath: string, newPath: string): DiffFileStatus {
  for (const line of lines) {
    if (line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ")) break;
    if (line.startsWith("new file mode")) return "added";
    if (line.startsWith("deleted file mode")) return "deleted";
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) return "renamed";
  }
  // Reconstructed/odd patches may carry distinct paths without rename lines.
  return oldPath !== newPath ? "renamed" : "modified";
}

export function parseDiffToFiles(rawPatch: string): DiffFile[] {
  const files: DiffFile[] = [];

  for (const chunk of splitDiffChunks(rawPatch)) {
    const lines = chunk.split("\n");
    const fromFileLines = parseDiffFilePathLines(lines);
    const fromMetadata = parseDiffMetadataPathLines(lines);
    const fromHeader = parseDiffGitHeader(lines[0] ?? "");
    const oldPath = fromFileLines.oldPath ?? fromFileLines.newPath ?? fromMetadata.oldPath ?? fromHeader.oldPath;
    const newPath = fromFileLines.newPath ?? fromFileLines.oldPath ?? fromMetadata.newPath ?? fromHeader.newPath;
    if (!oldPath || !newPath) continue;

    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }

    files.push({
      path: newPath,
      oldPath: oldPath !== newPath ? oldPath : undefined,
      patch: chunk,
      additions,
      deletions,
      status: deriveStatus(lines, oldPath, newPath),
    });
  }

  return files;
}
