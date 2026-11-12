import { parseDiffFilePathLines, parseDiffGitHeader, parseDiffMetadataPathLines } from "./diff-paths";

export type DiffFileStatus = "added" | "deleted" | "renamed" | "modified";

export interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
  status: DiffFileStatus;
}

const ANSI_CSI = /\x1b\[[0-9;:?]*[A-Za-z]/g;
const COLORED_DIFF_HEADER = /^(?:\x1b\[[0-9;:?]*[A-Za-z])+diff --git /m;

export function isColorizedPatch(rawPatch: string): boolean {
  return rawPatch.includes("\x1b[") && !/^diff --git /m.test(rawPatch) && COLORED_DIFF_HEADER.test(rawPatch);
}

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

function deriveStatus(lines: string[], oldPath: string, newPath: string): DiffFileStatus {
  for (const line of lines) {
    if (line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ")) break;
    if (line.startsWith("new file mode")) return "added";
    if (line.startsWith("deleted file mode")) return "deleted";
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) return "renamed";
  }
  return oldPath !== newPath ? "renamed" : "modified";
}

export function parseDiffToFiles(rawPatch: string): DiffFile[] {
  const files: DiffFile[] = [];

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

export interface PatchBlobIds {
  oldId: string;
  newId: string;
}

export function patchBlobIds(patch: string): PatchBlobIds | null {
  const ids = /^index ([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})/m.exec(patch);
  if (!ids || /^0+$/.test(ids[1]!) || /^0+$/.test(ids[2]!)) return null;
  return { oldId: ids[1]!, newId: ids[2]! };
}

export type DiffHunkLine =
  | { kind: "context"; oldLine: number; newLine: number; text: string }
  | { kind: "add"; newLine: number; text: string }
  | { kind: "del"; oldLine: number; text: string };

export interface DiffHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  lines: DiffHunkLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

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

function isFileHeaderRow(row: string, pastFirstHunk: boolean): boolean {
  if (pastFirstHunk) return row === "";
  if (row.startsWith("--- ") || row.startsWith("+++ ")) return true;
  return !/^(?:@@|[ +-])/.test(row);
}

function sideStart(start: number, count: number): number {
  return count === 0 ? start + 1 : start;
}

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
