// Plain changes: whatever no semantic pass explained still has to be described,
// because Pierre's semantic view only colors lines that operations own.
// Character-level edits from VS Code's diff are grouped into line blocks and
// become `added`, `deleted` or `edited` operations.
import type {
  SemanticDiffConnectorAttachment,
  SemanticDiffLineRegion,
  SemanticDiffOperation,
  SemanticDiffSpan,
  SemanticDiffTextPosition,
} from './pierre-types.ts';
import { range } from './syntax.ts';
import type { ChangeBlock } from './linediff.ts';
import { computeTextDiff, lastWork, positions, WORK_PER_SECOND } from './textdiff.ts';

/** A text replacement in file offsets: old [start, end) becomes newText. */
export interface Replacement {
  start: number;
  end: number;
  newText: string;
}

interface Piece {
  old: { start: SemanticDiffTextPosition; end: SemanticDiffTextPosition; empty: boolean };
  new: { start: SemanticDiffTextPosition; end: SemanticDiffTextPosition; empty: boolean };
}

/** Lines a character range touches; an empty range or one ending at column 0 does not take the next line. */
function linesOf(start: SemanticDiffTextPosition, end: SemanticDiffTextPosition, empty: boolean): SemanticDiffLineRegion | null {
  if (empty) return null;
  const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  return { start: start.line, end: last };
}

const lineStart = (line: number) => ({ line, character: 0 });

const wordCache = new Map<string, string[]>();
const words = (line: string) => {
  let w = wordCache.get(line);
  if (!w) {
    if (wordCache.size > 50_000) wordCache.clear();
    w = line.match(/\w+|\S/g) ?? [];
    wordCache.set(line, w);
  }
  return w;
};
function similar(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return x.length === y.length;
  const counts = new Map<string, number>();
  for (const t of x) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of y) {
    const c = counts.get(t);
    if (c) {
      shared++;
      counts.set(t, c - 1);
    }
  }
  return (2 * shared) / (x.length + y.length) >= 0.5;
}

/** One line edited in place: the span between their common prefix and suffix. */
function inLine(oldLine: number, newLine: number, oldLines: string[], newLines: string[]): Piece | null {
  const a = oldLines[oldLine - 1] ?? '';
  const b = newLines[newLine - 1] ?? '';
  if (a === b) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return {
    old: { start: { line: oldLine, character: p }, end: { line: oldLine, character: a.length - q }, empty: a.length - q === p },
    new: { start: { line: newLine, character: p }, end: { line: newLine, character: b.length - q }, empty: b.length - q === p },
  };
}

/**
 * VS Code's diff can express "edit this line, delete the next five" as one
 * replacement. Re-align the lines it touches: similar lines pair up as in-line
 * edits, the rest become whole-line deletions and insertions.
 */
function splitByLines(p: Piece, oldLines: string[], newLines: string[]): Piece[] {
  const o = { start: p.old.start.line, end: p.old.end.character === 0 && p.old.end.line > p.old.start.line ? p.old.end.line - 1 : p.old.end.line };
  const n = { start: p.new.start.line, end: p.new.end.character === 0 && p.new.end.line > p.new.start.line ? p.new.end.line - 1 : p.new.end.line };
  const oc = o.end - o.start + 1;
  const nc = n.end - n.start + 1;
  const wholeLines = p.old.start.character === 0 && p.new.start.character === 0 && p.old.end.character === 0 && p.new.end.character === 0;
  if ((oc <= 1 && nc <= 1) || (wholeLines && (p.old.empty || p.new.empty)) || oc * nc > 40_000) return [p];
  // Longest common subsequence of similar lines.
  const dp = Array.from({ length: oc + 1 }, () => new Array<number>(nc + 1).fill(0));
  const sim = Array.from({ length: oc }, (_, i) => Array.from({ length: nc }, (_, j) => similar(oldLines[o.start - 1 + i] ?? '', newLines[n.start - 1 + j] ?? '')));
  for (let i = oc - 1; i >= 0; i--)
    for (let j = nc - 1; j >= 0; j--) dp[i]![j] = sim[i]![j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Piece[] = [];
  let i = 0;
  let j = 0;
  const del = (line: number, at: number): Piece => ({
    old: { start: lineStart(line), end: lineStart(line + 1), empty: false },
    new: { start: lineStart(at), end: lineStart(at), empty: true },
  });
  const ins = (line: number, at: number): Piece => ({
    old: { start: lineStart(at), end: lineStart(at), empty: true },
    new: { start: lineStart(line), end: lineStart(line + 1), empty: false },
  });
  while (i < oc || j < nc) {
    if (i < oc && j < nc && sim[i]![j] && dp[i]![j] === dp[i + 1]![j + 1]! + 1) {
      const e = inLine(o.start + i, n.start + j, oldLines, newLines);
      if (e) out.push(e);
      i++;
      j++;
    } else if (i < oc && (j >= nc || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      out.push(del(o.start + i, n.start + j));
      i++;
    } else {
      out.push(ins(n.start + j, o.start + i));
      j++;
    }
  }
  return out;
}

export function detectEdits(replacements: Replacement[], oldText: string, newText: string): SemanticDiffOperation[] {
  const at = { old: positions(oldText), new: positions(newText) };
  const newLineCount = newText.split('\n').length - (newText.endsWith('\n') ? 1 : 0);
  const oldLineCount = oldText.split('\n').length - (oldText.endsWith('\n') ? 1 : 0);

  // Map each replacement to both files, splitting multi-line ones into lines.
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const pieces: Piece[] = [];
  let delta = 0;
  for (const r of replacements) {
    const ns = r.start + delta;
    const ne = ns + r.newText.length;
    delta += r.newText.length - (r.end - r.start);
    const piece: Piece = {
      old: { start: at.old(r.start), end: at.old(r.end), empty: r.end === r.start },
      new: { start: at.new(ns), end: at.new(ne), empty: r.newText.length === 0 },
    };
    pieces.push(...splitByLines(piece, oldLines, newLines));
  }

  // Group pieces whose lines touch on either side into blocks.
  const blocks: Array<{ pieces: Piece[]; old: SemanticDiffLineRegion | null; new: SemanticDiffLineRegion | null; whole: boolean }> = [];
  const join = (a: SemanticDiffLineRegion | null, b: SemanticDiffLineRegion | null) =>
    !a ? b : !b ? a : { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
  const touches = (a: SemanticDiffLineRegion | null, b: SemanticDiffLineRegion | null) => !!a && !!b && b.start <= a.end;
  for (const p of pieces) {
    // An edit inside a line (not a whole-line insertion or deletion) touches that line on both sides.
    const o = linesOf(p.old.start, p.old.end, p.old.empty) ?? (p.old.start.character > 0 || !p.new.empty && p.new.end.character > 0 ? { start: p.old.start.line, end: p.old.start.line } : null);
    const n = linesOf(p.new.start, p.new.end, p.new.empty) ?? (p.new.start.character > 0 || !p.old.empty && p.old.end.character > 0 ? { start: p.new.start.line, end: p.new.start.line } : null);
    // Whole lines inserted or deleted stay their own block, so they read as added or
    // deleted rather than being absorbed into a neighbouring in-line edit.
    const wholeLines = (p.old.empty || p.new.empty) && p.old.start.character === 0 && p.new.start.character === 0 && p.old.end.character === 0 && p.new.end.character === 0;
    const last = blocks.at(-1);
    const lastWhole = last?.whole ?? false;
    if (last && lastWhole === wholeLines && (touches(last.old, o) || touches(last.new, n))) {
      last.pieces.push(p);
      last.old = join(last.old, o);
      last.new = join(last.new, n);
    } else {
      blocks.push({ pieces: [p], old: o, new: n, whole: wholeLines });
    }
  }

  const ops: SemanticDiffOperation[] = [];
  for (const b of blocks) {
    const first = b.pieces[0]!;
    if (b.old && b.new) {
      const spans: SemanticDiffSpan[] = [
        {
          role: 'root',
          relation: 'mapped',
          old: [range(lineStart(b.old.start), lineStart(b.old.end + 1))],
          new: [range(lineStart(b.new.start), lineStart(b.new.end + 1))],
          linePairs: [{ old: b.old, new: b.new }],
        },
      ];
      for (const p of b.pieces) {
        if (p.old.empty) spans.push({ role: 'focus', relation: 'introduced', new: [range(p.new.start, p.new.end)] });
        else if (p.new.empty) spans.push({ role: 'focus', relation: 'removed', old: [range(p.old.start, p.old.end)] });
        else spans.push({ role: 'focus', relation: 'replaced', old: [range(p.old.start, p.old.end)], new: [range(p.new.start, p.new.end)], linePairs: [] });
      }
      ops.push({ type: 'edited', spans, lines: { old: [{ ...b.old, spanIndex: 0 }], new: [{ ...b.new, spanIndex: 0 }] } });
    } else if (b.old) {
      // Deleted lines connect to where they would sit in the new file.
      const at = first.new.start.line;
      const attachment: SemanticDiffConnectorAttachment =
        newLineCount === 0 ? { empty: true } : at <= newLineCount ? { line: at, edge: 'before' } : { line: newLineCount, edge: 'after' };
      ops.push({
        type: 'deleted',
        spans: [{ role: 'root', relation: 'removed', old: [range(lineStart(b.old.start), lineStart(b.old.end + 1))] }],
        lines: { old: [{ ...b.old, spanIndex: 0, attachment }], new: [] },
      });
    } else if (b.new) {
      const at = first.old.start.line;
      const attachment: SemanticDiffConnectorAttachment =
        oldLineCount === 0 ? { empty: true } : at <= oldLineCount ? { line: at, edge: 'before' } : { line: oldLineCount, edge: 'after' };
      ops.push({
        type: 'added',
        spans: [{ role: 'root', relation: 'introduced', new: [range(lineStart(b.new.start), lineStart(b.new.end + 1))] }],
        lines: { old: [], new: [{ ...b.new, spanIndex: 0, attachment }] },
      });
    }
  }
  return ops;
}

/**
 * Character-level replacements for the changed blocks of a line diff: blocks
 * changed on both sides are refined with VS Code's diff; one-sided blocks
 * become whole-line insertions or deletions.
 */
/** Total work for character-level diffs of changed blocks in one file, and the most for one block. */
const EDIT_BUDGET = 0.6 * WORK_PER_SECOND;
const BLOCK_BUDGET = 0.25 * WORK_PER_SECOND;

export function replacementsFromBlocks(blocks: ChangeBlock[], oldText: string, newText: string): Replacement[] {
  const lineOffsets = (text: string) => {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    starts.push(text.length);
    return (line: number) => starts[Math.min(line - 1, starts.length - 1)]!;
  };
  const o = lineOffsets(oldText);
  const n = lineOffsets(newText);
  const out: Replacement[] = [];
  // One work budget for the whole file (work, not time, so the result is repeatable): past it, changed blocks are replaced whole
  // (still correct, just less precise) instead of each getting its own character diff.
  let left = EDIT_BUDGET;
  for (const b of blocks) {
    const os = b.old ? o(b.old.start) : o(b.oldAt);
    const oe = b.old ? o(b.old.end + 1) : os;
    const ns = b.new ? n(b.new.start) : n(b.newAt);
    const ne = b.new ? n(b.new.end + 1) : ns;
    if (!b.old || !b.new || left < BLOCK_BUDGET / 12) {
      out.push({ start: os, end: oe, newText: newText.slice(ns, ne) });
      continue;
    }
    const inner = computeTextDiff(oldText.slice(os, oe), newText.slice(ns, ne), Math.min(BLOCK_BUDGET, left));
    left -= lastWork;
    for (const r of inner.edits.replacements) out.push({ start: os + r.range.start, end: os + r.range.endExclusive, newText: r.newText });
  }
  return out;
}
