import { diffLines } from 'diff';

/**
 * Pre-edit coordinates are session-invariant: the pristine content never changes while the session
 * runs, so an anchor mapped at click time stays correct after the session completes OR is
 * discarded, no matter what the user edits afterwards.
 */
export interface PristineAnchor {
  lineStart: number;
  lineEnd: number;
  exact: boolean;
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function countLines(content: string): number {
  if (content === '') return 0;
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

interface SameSegment {
  kind: 'same';
  editStart: number;
  editEnd: number;
  origStart: number;
}

interface ChangedSegment {
  kind: 'changed';
  editStart: number;
  editEnd: number;
  origStart: number;
  origEnd: number;
}

type Segment = SameSegment | ChangedSegment;

function buildSegments(original: string, edited: string): Segment[] {
  const parts = diffLines(original, edited);
  const segments: Segment[] = [];
  let origLine = 1;
  let editLine = 1;
  let pending: ChangedSegment | null = null;

  const flush = () => {
    if (pending) {
      segments.push(pending);
      pending = null;
    }
  };

  for (const part of parts) {
    const n = countLines(part.value);
    if (n === 0) continue;
    if (part.added) {
      pending ??= {
        kind: 'changed',
        editStart: editLine,
        editEnd: editLine - 1,
        origStart: origLine,
        origEnd: origLine - 1,
      };
      pending.editEnd = editLine + n - 1;
      editLine += n;
    } else if (part.removed) {
      pending ??= {
        kind: 'changed',
        editStart: editLine,
        editEnd: editLine - 1,
        origStart: origLine,
        origEnd: origLine - 1,
      };
      pending.origEnd = origLine + n - 1;
      origLine += n;
    } else {
      flush();
      segments.push({ kind: 'same', editStart: editLine, editEnd: editLine + n - 1, origStart: origLine });
      origLine += n;
      editLine += n;
    }
  }
  flush();
  return segments;
}

export function mapEditedRangeToPristine(
  preEditContent: string,
  editedContent: string,
  editedLineStart: number,
  editedLineEnd: number,
): PristineAnchor {
  const original = normalize(preEditContent);
  const edited = normalize(editedContent);
  const origCount = countLines(original);
  const editCount = countLines(edited);

  if (origCount === 0) return { lineStart: 1, lineEnd: 1, exact: false };

  const clamp = (line: number) => Math.min(Math.max(line, 1), origCount);
  let s = Math.max(1, Math.min(editedLineStart, editedLineEnd));
  let e = Math.min(Math.max(editedLineStart, editedLineEnd), Math.max(editCount, 1));
  if (s > e) s = e;

  if (original === edited) {
    return { lineStart: clamp(s), lineEnd: clamp(e), exact: true };
  }

  const segments = buildSegments(original, edited);
  let minLine = Number.POSITIVE_INFINITY;
  let maxLine = Number.NEGATIVE_INFINITY;
  let exact = true;
  const extend = (a: number, b: number) => {
    minLine = Math.min(minLine, a);
    maxLine = Math.max(maxLine, b);
  };

  for (const seg of segments) {
    if (seg.kind === 'same') {
      const from = Math.max(s, seg.editStart);
      const to = Math.min(e, seg.editEnd);
      if (from > to) continue;
      extend(seg.origStart + (from - seg.editStart), seg.origStart + (to - seg.editStart));
      continue;
    }
    const hasEditedLines = seg.editEnd >= seg.editStart;
    const hasOrigLines = seg.origEnd >= seg.origStart;
    if (hasEditedLines) {
      if (seg.editStart > e || seg.editEnd < s) continue;
      exact = false;
      if (hasOrigLines) {
        extend(seg.origStart, seg.origEnd);
      } else {
        const anchor = seg.origStart > 1 ? seg.origStart - 1 : clamp(seg.origStart);
        extend(anchor, anchor);
      }
    } else if (hasOrigLines) {
      if (s < seg.editStart && e >= seg.editStart) {
        exact = false;
        extend(seg.origStart, seg.origEnd);
      }
    }
  }

  if (!Number.isFinite(minLine)) {
    return { lineStart: clamp(s), lineEnd: clamp(e), exact: false };
  }
  return { lineStart: clamp(minLine), lineEnd: clamp(maxLine), exact };
}

/** Mirrors the line-range treatment in Pierre's own selection-action demo. */
export function selectionToLineRange(selection: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): { lineStart: number; lineEnd: number } {
  const endLine =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line - 1
      : selection.end.line;
  return {
    lineStart: Math.min(selection.start.line, endLine) + 1,
    lineEnd: Math.max(selection.start.line, endLine) + 1,
  };
}
