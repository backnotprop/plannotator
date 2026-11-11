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

/** ANSI CSI sequences (SGR color/bold `\x1b[1;31m`, the bare reset `\x1b[m`, …). */
const ANSI_CSI = /\x1b\[[0-9;:?]*[A-Za-z]/g;
/** A file header line that a terminal color code was wrapped around. */
const COLORED_DIFF_HEADER = /^(?:\x1b\[[0-9;:?]*[A-Za-z])+diff --git /m;

/**
 * True when the patch's own headers carry ANSI color codes, the shape a VCS
 * produces when the user's config forces color into a pipe (`color.diff =
 * always`, jj `ui.color = "always"`; #1661). A normal patch never matches:
 * its `diff --git` headers are plain, and escape bytes inside a changed file's
 * content sit after a `+`/`-`/space prefix, never at the start of a header.
 */
export function isColorizedPatch(rawPatch: string): boolean {
  return rawPatch.includes("\x1b[") && !/^diff --git /m.test(rawPatch) && COLORED_DIFF_HEADER.test(rawPatch);
}

/**
 * Remove terminal color codes from a colorized patch so it still parses.
 * Returns any other patch unchanged, byte for byte, so content that really
 * contains escape bytes is never altered.
 */
export function stripPatchColor(rawPatch: string): string {
  return isColorizedPatch(rawPatch) ? rawPatch.replace(ANSI_CSI, "") : rawPatch;
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

  // A patch that arrived colorized would otherwise parse to 0 files and look
  // exactly like "no changes" (#1661). The VCS runners turn color off; this
  // covers patches from anywhere else (piped patch files, older servers).
  for (const chunk of splitDiffChunks(stripPatchColor(rawPatch))) {
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

/** The two blobs a file's patch runs between (its `index` line). */
export interface PatchBlobIds {
  oldId: string;
  newId: string;
}

/** A file's `index` blob ids; null when there is no such line (GitLab's rebuilt patches) or a side does not exist (all zeros). */
export function patchBlobIds(patch: string): PatchBlobIds | null {
  const ids = /^index ([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})/m.exec(patch);
  if (!ids || /^0+$/.test(ids[1]!) || /^0+$/.test(ids[2]!)) return null;
  return { oldId: ids[1]!, newId: ids[2]! };
}

/** One line of a hunk, numbered on each side it exists on. `text` drops the ` `/`+`/`-` prefix. */
export type DiffHunkLine =
  | { kind: "context"; oldLine: number; newLine: number; text: string }
  | { kind: "add"; newLine: number; text: string }
  | { kind: "del"; oldLine: number; text: string };

/**
 * One `@@` hunk. Each side is the half-open line range `[start, end)` it
 * covers; an empty side (`-3,0`) has `start === end`, placed after the line
 * its header names. Lines past the hunk move by `newEnd - oldEnd`.
 */
export interface DiffHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  lines: DiffHunkLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The hunks of one file's patch (a `DiffFile.patch`), in order, with every
 * line numbered. The file header before the first hunk is skipped, and so is
 * `\ No newline at end of file`. Returns null for anything else it cannot
 * account for: a hunk whose lines do not add up to its header, hunks that
 * overlap, an `@@` row it cannot read (combined `@@@` diffs included), or a
 * line of content outside a hunk. A truncated or hand-edited patch is never
 * read as a shorter valid one.
 */
export function diffHunkLines(patch: string): DiffHunk[] | null {
  const rows = patch.split("\n");
  const hunks: DiffHunk[] = [];
  for (let i = 0; i < rows.length; ) {
    const header = HUNK_HEADER.exec(rows[i]);
    if (!header) {
      if (!isFileHeaderRow(rows[i], hunks.length > 0)) return null;
      i += 1;
      continue;
    }
    const read = readHunk(header, rows, i + 1);
    const previous = hunks.at(-1);
    if (!read || (previous && (read.hunk.oldStart < previous.oldEnd || read.hunk.newStart < previous.newEnd))) return null;
    hunks.push(read.hunk);
    i = read.next;
  }
  return hunks;
}

/**
 * True for a row that may stand outside a hunk. Before the first hunk that is
 * the file header (`---`/`+++` included, but no other content row and no
 * `@@` row); after it, only the blank row that ends the patch.
 */
function isFileHeaderRow(row: string, pastFirstHunk: boolean): boolean {
  if (pastFirstHunk) return row === "";
  if (row.startsWith("--- ") || row.startsWith("+++ ")) return true;
  return !/^(?:@@|[ +-])/.test(row);
}

/** First line number a hunk side covers: an empty side's header names the line before it. */
function sideStart(start: number, count: number): number {
  return count === 0 ? start + 1 : start;
}

/** Reads the hunk whose header was just matched; `next` is the row after it. Null when the rows do not fit the header. */
function readHunk(header: RegExpExecArray, rows: readonly string[], from: number): { hunk: DiffHunk; next: number } | null {
  let oldLeft = Number(header[2] ?? "1");
  let newLeft = Number(header[4] ?? "1");
  let oldLine = sideStart(Number(header[1]), oldLeft);
  let newLine = sideStart(Number(header[3]), newLeft);
  const hunk: DiffHunk = { oldStart: oldLine, oldEnd: oldLine + oldLeft, newStart: newLine, newEnd: newLine + newLeft, lines: [] };
  let i = from;
  for (; oldLeft > 0 || newLeft > 0; i += 1) {
    const row = rows[i];
    if (row === undefined) return null;
    const text = row.slice(1);
    if (row.startsWith("\\")) continue;
    if (row.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
      hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text });
      oldLeft -= 1;
      newLeft -= 1;
    } else if (row.startsWith("-") && oldLeft > 0) {
      hunk.lines.push({ kind: "del", oldLine: oldLine++, text });
      oldLeft -= 1;
    } else if (row.startsWith("+") && newLeft > 0) {
      hunk.lines.push({ kind: "add", newLine: newLine++, text });
      newLeft -= 1;
    } else {
      return null;
    }
  }
  while (rows[i]?.startsWith("\\")) i += 1;
  return { hunk, next: i };
}

/** Return true only when the complete source range is represented by one diff hunk. */
export function isLineRangeInPatch(
  patch: string,
  lineStart: number,
  lineEnd: number,
  side: "old" | "new",
): boolean {
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
    return false;
  }
  for (const line of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(side === "old" ? match[1] : match[3]);
    const count = Number((side === "old" ? match[2] : match[4]) ?? "1");
    if (count === 0) continue;
    if (lineStart >= start && lineEnd <= start + count - 1) return true;
  }
  return false;
}
