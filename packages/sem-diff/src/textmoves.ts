// Line-block moves found by VS Code's diff (`@vscode/diff`, MIT): blocks of
// statements moved inside or between functions, which declaration matching
// cannot see. Moves that also changed get focus spans for the edited text.
import type { SemanticDiffFold, SemanticDiffOperation, SemanticDiffSpan } from './pierre-types.ts';
import { range } from './syntax.ts';
import { positions, type TextDiff } from './textdiff.ts';

/** A moved block may differ by at most this share of its characters; beyond that it reads as rewritten. */
export const MAX_MOVED_EDIT_RATIO = 0.2;

export function detectTextMoves(result: TextDiff, oldText: string, newText: string): { operations: SemanticDiffOperation[]; folds: SemanticDiffFold[] } {
  const operations: SemanticDiffOperation[] = [];
  const folds: SemanticDiffFold[] = [];
  if (result.hitTimeout) return { operations, folds };
  const at = { old: positions(oldText), new: positions(newText) };
  const text = { old: oldText.split('\n'), new: newText.split('\n') };

  for (const move of result.moves) {
    const o = move.range.original;
    const m = move.range.modified;
    const changed = move.innerEdit.replacements.reduce((n, r) => n + Math.max(r.range.length, r.newText.length), 0);
    if (changed > MAX_MOVED_EDIT_RATIO * Math.max(o.length, m.length)) continue;
    // Ranges cover whole lines and end at the start of the next line.
    const oldStart = at.old(o.start);
    const oldEnd = at.old(o.endExclusive);
    const newStart = at.new(m.start);
    const newEnd = at.new(m.endExclusive);
    const oldLines = { start: oldStart.line, end: oldEnd.character === 0 ? oldEnd.line - 1 : oldEnd.line };
    const newLines = { start: newStart.line, end: newEnd.character === 0 ? newEnd.line - 1 : newEnd.line };
    trimEdges(oldLines, newLines, text.old, text.new);
    // Too little left, or text that repeats in the file (`if err != nil { return err }`):
    // there is no telling which copy moved where.
    const block = nonBlank(text.old, oldLines);
    if (block.length < 2 || occurrences(text.old, block) > 1 || occurrences(text.new, nonBlank(text.new, newLines)) > 1) continue;
    const inside = (side: 'old' | 'new', r: { start: { line: number }; end: { line: number } }) => {
      const l = side === 'old' ? oldLines : newLines;
      return r.start.line >= l.start && r.end.line <= l.end + 1;
    };
    const spans: SemanticDiffSpan[] = [
      {
        role: 'root',
        relation: 'moved',
        old: [range({ line: oldLines.start, character: 0 }, { line: oldLines.end + 1, character: 0 })],
        new: [range({ line: newLines.start, character: 0 }, { line: newLines.end + 1, character: 0 })],
        linePairs: [{ old: oldLines, new: newLines }],
      },
    ];
    // Edits inside the moved text, mapped to both files.
    let delta = 0;
    for (const r of move.innerEdit.replacements) {
      const os = o.start + r.range.start;
      const oe = o.start + r.range.endExclusive;
      const ns = m.start + r.range.start + delta;
      const ne = ns + r.newText.length;
      delta += r.newText.length - r.range.length;
      if (os === oe) spans.push({ role: 'focus', relation: 'introduced', new: [range(at.new(ns), at.new(ne))] });
      else if (ns === ne) spans.push({ role: 'focus', relation: 'removed', old: [range(at.old(os), at.old(oe))] });
      else spans.push({ role: 'focus', relation: 'replaced', old: [range(at.old(os), at.old(oe))], new: [range(at.new(ns), at.new(ne))], linePairs: [] });
    }
    // Keep only the edits inside the (trimmed) block.
    for (let i = spans.length - 1; i > 0; i--) {
      const sp = spans[i]!;
      const olds = 'old' in sp ? (sp.old ?? []) : [];
      const news = 'new' in sp ? (sp.new ?? []) : [];
      if (!olds.every((r) => inside('old', r)) || !news.every((r) => inside('new', r))) spans.splice(i, 1);
    }
    const edited = spans.length > 1 || nonBlank(text.old, oldLines).join('\n') !== nonBlank(text.new, newLines).join('\n');
    const index = operations.push({
      type: edited ? 'movedWithEdit' : 'moved',
      spans,
      lines: { old: [{ ...oldLines, spanIndex: 0 }], new: [{ ...newLines, spanIndex: 0 }] },
    }) - 1;
    if (!edited) folds.push({ old: oldLines, operations: [index], counts: { moved: oldLines.end - oldLines.start + 1, edited: 0, removed: 0 } });
  }
  return { operations, folds };
}

type Lines = { start: number; end: number };
const norm = (l: string | undefined) => (l ?? '').trim();

/** Trimmed non-blank lines of a block. */
function nonBlank(lines: string[], r: Lines): string[] {
  return lines.slice(r.start - 1, r.end).map(norm).filter(Boolean);
}

/** How often a block (as trimmed non-blank lines) appears in a file. */
function occurrences(lines: string[], block: string[]): number {
  if (!block.length) return 0;
  const flat = lines.map(norm).filter(Boolean);
  let n = 0;
  for (let i = 0; i + block.length <= flat.length; i++) {
    if (flat[i] !== block[0]) continue;
    let k = 1;
    while (k < block.length && flat[i + k] === block[k]) k++;
    if (k === block.length) n++;
  }
  return n;
}

/**
 * VS Code's moves can take in a neighbouring line that did not move (the next
 * import in a sorted list, an `if (x) {` wrapped around the block). Drop edge
 * lines that have no counterpart in the other side's block.
 */
function trimEdges(o: Lines, n: Lines, oldText: string[], newText: string[]) {
  const has = (lines: string[], r: Lines, line: string) => lines.slice(r.start - 1, r.end).some((l) => norm(l) === line);
  for (const end of ['start', 'end'] as const) {
    const step = end === 'start' ? 1 : -1;
    while (o.start <= o.end && n.start <= n.end) {
      const a = norm(oldText[o[end] - 1]);
      const b = norm(newText[n[end] - 1]);
      if (a === b || similar(a, b)) break; // an edited edge line still moved
      const dropOld = !has(newText, n, a);
      const dropNew = !has(oldText, o, b);
      if (!dropOld && !dropNew) break;
      if (dropOld) o[end] += step;
      if (dropNew) n[end] += step;
    }
  }
}

const KEYWORDS = new Set(['import', 'export', 'from', 'type', 'const', 'let', 'var', 'return', 'func', 'function', 'if', 'else', 'for']);
const words = (l: string) => (l.match(/\w{2,}/g) ?? []).filter((w) => !KEYWORDS.has(w));

/** Two lines share most of their words: one is an edit of the other. */
function similar(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return false;
  const pool = [...y];
  let common = 0;
  for (const w of x) {
    const i = pool.indexOf(w);
    if (i >= 0) { common++; pool.splice(i, 1); }
  }
  return (2 * common) / (x.length + y.length) >= 0.5;
}
