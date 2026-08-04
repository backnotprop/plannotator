import { diffLines } from 'diff';

/**
 * Anchor mapping for "Make annotation" selections made INSIDE an edit session.
 *
 * The selection lives in the EDITED buffer, but annotations anchor to the
 * rendered diff's new-side line numbers — which are the session's PRE-EDIT
 * content (the pristine FileDiffMetadata restored when the session ends).
 * Pre-edit coordinates are session-invariant: the pristine content never
 * changes while the session runs, so an anchor mapped at click time stays
 * correct after the session completes OR is discarded, no matter what the
 * user edits afterwards.
 *
 * Mapping rules (computed from diffLines(preEdit, edited) at click time):
 * - Lines in UNEDITED regions map 1:1 (edits above only shift the offset,
 *   which the diff walk accounts for). This is the common case — a reviewer
 *   highlighting existing code — and it maps exactly (`exact: true`).
 * - Lines in EDITED regions map to the pristine lines that region replaces
 *   (the removed side of the modification). The annotation is still created,
 *   but flagged `exact: false` so the caller can record the highlighted text
 *   and label the anchor as approximate.
 * - Lines in PURE-INSERT regions (no pristine lines replaced) anchor to the
 *   adjacent pristine line, preferring the preceding one — the same anchor
 *   preference deriveSuggestionHunks uses. Also `exact: false`.
 * - A selection whose covering range straddles a pure DELETION (kept lines
 *   highlighted on both sides of removed pristine lines) includes the removed
 *   lines in its covering range and is flagged `exact: false` — the range is
 *   honest but wider than what was highlighted.
 * - Results are clamped to [1, pristine line count]; an empty pristine file
 *   anchors to line 1 with `exact: false`.
 */
export interface PristineAnchor {
  /** 1-based first pristine (pre-edit, new-side) line of the anchor. */
  lineStart: number;
  /** 1-based last pristine line of the anchor (inclusive). */
  lineEnd: number;
  /** True when every highlighted line lies in an unedited region and the
   * covering range contains no in-session changes. */
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
  /** Pristine line corresponding to editStart. */
  origStart: number;
}

interface ChangedSegment {
  kind: 'changed';
  /** Edited lines this region occupies (empty for pure deletions: editEnd < editStart). */
  editStart: number;
  editEnd: number;
  /** Pristine lines this region replaces (empty for pure inserts: origEnd < origStart). */
  origStart: number;
  origEnd: number;
}

type Segment = SameSegment | ChangedSegment;

/** Group the diffLines parts into alternating same/changed segments with both
 * coordinate spaces attached. Consecutive removed+added parts fold into one
 * changed segment regardless of emission order. */
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

/**
 * Map a 1-based inclusive line range of the EDITED buffer to the pristine
 * (pre-edit) new-side coordinates the annotation system anchors to.
 */
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
        // Modification: anchor to the pristine lines the edit replaces.
        extend(seg.origStart, seg.origEnd);
      } else {
        // Pure insert: anchor to the adjacent pristine line, preferring the
        // preceding one (mirrors deriveSuggestionHunks' anchor preference).
        const anchor = seg.origStart > 1 ? seg.origStart - 1 : clamp(seg.origStart);
        extend(anchor, anchor);
      }
    } else if (hasOrigLines) {
      // Pure deletion: occupies no edited lines. It sits strictly inside the
      // selection only when highlighted lines exist on BOTH sides — i.e. the
      // selection starts before the deletion point and ends at or after it.
      if (s < seg.editStart && e >= seg.editStart) {
        exact = false;
        extend(seg.origStart, seg.origEnd);
      }
    }
  }

  if (!Number.isFinite(minLine)) {
    // Selection matched no segment (degenerate input): clamp into the file.
    return { lineStart: clamp(s), lineEnd: clamp(e), exact: false };
  }
  return { lineStart: clamp(minLine), lineEnd: clamp(maxLine), exact };
}

/**
 * Convert an editor selection (zero-based Positions, exclusive-feeling end:
 * a selection ending at character 0 of a line does not include that line)
 * into a 1-based inclusive line range. Mirrors the line-range treatment in
 * Pierre's own selection-action demo.
 */
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
