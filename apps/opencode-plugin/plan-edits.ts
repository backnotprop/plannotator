import path from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

export interface PlanEdit {
  start: number;
  end?: number | null;
  content: string;
}

export function getPlanBackingPath(project: string): string {
  return path.join(getPlannotatorDataDir(), "active", project, "_active-plan.md");
}

export function applyEdits(existingLines: string[], edits: PlanEdit[]): string[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const lines = [...existingLines];
  let offset = 0;

  for (const edit of sorted) {
    const start = edit.start - 1 + offset;
    const end = edit.end != null
      ? edit.end + offset
      : lines.length;

    const newLines = edit.content ? edit.content.split("\n") : [];
    const removedCount = end - start;
    lines.splice(start, removedCount, ...newLines);
    offset += newLines.length - removedCount;
  }

  return lines;
}

export function validateEdits(existingLines: string[], edits: PlanEdit[]): string | null {
  const lineCount = existingLines.length;

  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || edit.start < 1) {
      return `start must be a positive integer >= 1, got ${edit.start}`;
    }
    if (edit.start > lineCount + 1) {
      return `start (${edit.start}) exceeds file length + 1 (${lineCount + 1})`;
    }
    if (edit.end != null) {
      if (!Number.isInteger(edit.end) || edit.end < edit.start) {
        return `end (${edit.end}) must be >= start (${edit.start})`;
      }
      if (edit.end > lineCount && lineCount > 0) {
        return `end (${edit.end}) exceeds file length (${lineCount})`;
      }
    }
  }

  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.start > lineCount) continue;
    const prevEnd = prev.end ?? lineCount;
    if (curr.start <= prevEnd) {
      return `edits overlap: [${prev.start},${prevEnd}] and [${curr.start},${curr.end ?? "end"}]`;
    }
  }

  return null;
}

export function formatWithLineNumbers(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width)}| ${line}`)
    .join("\n");
}
