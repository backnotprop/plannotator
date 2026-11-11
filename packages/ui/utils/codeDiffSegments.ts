/**
 * Unchanged and added text take the NEW side's colours, removed text the OLD side's, so a
 * removed `50` is still a number.
 */
import type { HighlightRun } from "./codeHighlight";
import type { InlineDiffToken } from "./planDiffEngine";

/** A stretch of text in one colour (`style` absent: the default text colour). */
export interface CodePiece {
  text: string;
  style?: string;
}

/** Pieces drawn the same way: a word-diff mark, struck (a removed line's text), or plain. */
export interface CodeSegment {
  mark?: "added" | "removed";
  struck?: boolean;
  pieces: CodePiece[];
}

/** `text.slice(start, end)` cut at the run boundaries, each piece in its run's style. */
export function slicePieces(text: string, runs: readonly HighlightRun[] | null, start: number, end: number): CodePiece[] {
  if (start >= end) return [];
  if (!runs || runs.length === 0) return [{ text: text.slice(start, end) }];
  const pieces: CodePiece[] = [];
  let at = start;
  for (const run of runs) {
    if (run.end <= at) continue;
    if (run.start >= end) break;
    if (run.start > at) {
      pieces.push({ text: text.slice(at, run.start) });
      at = run.start;
    }
    const stop = Math.min(run.end, end);
    pieces.push({ text: text.slice(at, stop), style: run.style });
    at = stop;
  }
  if (at < end) pieces.push({ text: text.slice(at, end) });
  return pieces;
}

/** `[start, end)` split so each line's leading spaces and tabs are their own range. */
export function indentRanges(text: string, start: number, end: number): { start: number; end: number; indent: boolean }[] {
  const out: { start: number; end: number; indent: boolean }[] = [];
  let from = start;
  let i = start;
  while (i < end) {
    const lineStart = i === 0 || text[i - 1] === "\n";
    if (lineStart && (text[i] === " " || text[i] === "\t")) {
      let j = i;
      while (j < end && (text[j] === " " || text[j] === "\t")) j++;
      if (i > from) out.push({ start: from, end: i, indent: false });
      out.push({ start: i, end: j, indent: true });
      from = j;
      i = j;
      continue;
    }
    i++;
  }
  if (from < end) out.push({ start: from, end, indent: false });
  return out;
}

/** A whole chunk: plain, or `struck` (a removed one) with its indentation left unstruck. */
export function chunkSegments(text: string, runs: readonly HighlightRun[] | null, struck: boolean): CodeSegment[] {
  if (!struck) return [{ pieces: slicePieces(text, runs, 0, text.length) }];
  return indentRanges(text, 0, text.length).map((r) => ({
    struck: !r.indent,
    pieces: slicePieces(text, runs, r.start, r.end),
  }));
}

/** A modified block's word diff over both sides' colours. */
export function wordDiffSegments(
  oldText: string,
  newText: string,
  tokens: readonly InlineDiffToken[],
  oldRuns: readonly HighlightRun[] | null,
  newRuns: readonly HighlightRun[] | null,
): CodeSegment[] {
  const out: CodeSegment[] = [];
  let o = 0;
  let n = 0;
  for (const token of tokens) {
    const len = token.value.length;
    if (token.type === "removed") {
      const matches = oldText.slice(o, o + len) === token.value;
      for (const r of indentRanges(oldText, o, o + len)) {
        const pieces = matches ? slicePieces(oldText, oldRuns, r.start, r.end) : [{ text: oldText.slice(r.start, r.end) }];
        out.push(r.indent ? { pieces } : { mark: "removed", pieces });
      }
      o += len;
      continue;
    }
    const matches = newText.slice(n, n + len) === token.value;
    const pieces = matches ? slicePieces(newText, newRuns, n, n + len) : [{ text: token.value }];
    out.push(token.type === "added" ? { mark: "added", pieces } : { pieces });
    n += len;
    if (token.type === "unchanged") o += len;
  }
  return out;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const STRUCK_CLASS = "line-through decoration-destructive/30";

export function codeSegmentsToHtml(segments: readonly CodeSegment[]): string {
  let html = "";
  for (const segment of segments) {
    let inner = "";
    for (const piece of segment.pieces) {
      const text = escapeHtml(piece.text);
      inner += piece.style ? `<span style="${escapeHtml(piece.style)}">${text}</span>` : text;
    }
    if (segment.mark === "added") html += `<ins class="plan-diff-word-added">${inner}</ins>`;
    else if (segment.mark === "removed") html += `<del class="plan-diff-word-removed">${inner}</del>`;
    else if (segment.struck) html += `<span class="${STRUCK_CLASS}" data-plan-diff-struck="">${inner}</span>`;
    else html += inner;
  }
  return html;
}
