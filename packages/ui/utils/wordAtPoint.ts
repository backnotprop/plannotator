/**
 * The word under a screen point, for click-a-word and word-snapped drags.
 *
 * `Intl.Segmenter` with `granularity: 'word'` finds words in any script
 * (Chinese, Japanese and Thai have no spaces). Where it is missing, a run of
 * letters, marks and numbers is a word, with an apostrophe or a hyphen
 * between letters kept inside it ("don't", "re-run").
 *
 * A word is looked for in the run of adjacent sibling text nodes around the
 * position, so a word split into two text nodes (a removed highlight leaves
 * that) is still one word. It never crosses an element: a word half in bold
 * is two words here.
 */

import { caretAtPoint } from './caretAtPoint';

export { caretAtPoint };

export interface TextPosition {
  node: Text;
  offset: number;
}

export interface WordBounds {
  start: TextPosition;
  end: TextPosition;
}

interface SegmentLike { segment: string; index: number; isWordLike?: boolean }
interface SegmenterLike { segment(text: string): Iterable<SegmentLike> }
type SegmenterCtor = new (locales?: string[], options?: { granularity: 'word' }) => SegmenterLike;

let segmenter: SegmenterLike | null = null;
let segmenterLooked = false;

function getSegmenter(): SegmenterLike | null {
  if (!segmenterLooked) {
    segmenterLooked = true;
    const Ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
    try {
      segmenter = Ctor ? new Ctor([], { granularity: 'word' }) : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;
const JOINER = /['’-]/;

/** [start, end) of the word holding the character at `index`, or null when that character is not in a word. */
export function wordSpanAt(text: string, index: number, useSegmenter = true): [number, number] | null {
  if (index < 0 || index >= text.length) return null;
  const seg = useSegmenter ? getSegmenter() : null;
  if (seg) {
    for (const s of seg.segment(text)) {
      const end = s.index + s.segment.length;
      if (index >= s.index && index < end) return s.isWordLike ? [s.index, end] : null;
    }
    return null;
  }
  const isWordChar = (i: number) => WORD_CHAR.test(text[i] ?? '');
  const inWord = (i: number) => isWordChar(i) || (JOINER.test(text[i] ?? '') && isWordChar(i - 1) && isWordChar(i + 1));
  if (!isWordChar(index)) return null;
  let start = index;
  let end = index + 1;
  while (start > 0 && inWord(start - 1)) start -= 1;
  while (end < text.length && inWord(end)) end += 1;
  return [start, end];
}

function textRun(node: Text): Text[] {
  let first: Node = node;
  while (first.previousSibling?.nodeType === Node.TEXT_NODE) first = first.previousSibling;
  const run: Text[] = [];
  for (let n: Node | null = first; n && n.nodeType === Node.TEXT_NODE; n = n.nextSibling) run.push(n as Text);
  return run;
}

function positionIn(run: Text[], index: number, preferEnd: boolean): TextPosition {
  let left = index;
  for (let i = 0; i < run.length; i += 1) {
    const len = run[i].length;
    if (left < len || (left === len && (preferEnd || i === run.length - 1))) return { node: run[i], offset: left };
    left -= len;
  }
  const last = run[run.length - 1];
  return { node: last, offset: last.length };
}

/**
 * The word holding the character after the caret (`side` 1) or before it
 * (`side` -1, for a caret at the end of a word).
 */
export function wordAround(node: Node, offset: number, side: 1 | -1 = 1): WordBounds | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const run = textRun(node as Text);
  let base = 0;
  for (const t of run) {
    if (t === node) break;
    base += t.length;
  }
  const text = run.map((t) => t.data).join('');
  const span = wordSpanAt(text, base + offset + (side === -1 ? -1 : 0));
  if (!span) return null;
  return { start: positionIn(run, span[0], false), end: positionIn(run, span[1], true) };
}

export function wordRange(word: WordBounds): Range {
  const range = document.createRange();
  range.setStart(word.start.node, word.start.offset);
  range.setEnd(word.end.node, word.end.offset);
  return range;
}

/** Whether (x, y) is on the word's rendered glyphs, within `slop` CSS px. */
export function pointOnWord(word: WordBounds, x: number, y: number, slop = 1): boolean {
  return Array.from(wordRange(word).getClientRects()).some(
    (r) => x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop,
  );
}

/** The word whose glyphs are under (x, y), or null (a space, punctuation, a margin, a gap). */
export function wordAtPoint(x: number, y: number): WordBounds | null {
  const caret = caretAtPoint(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null;
  for (const side of [1, -1] as const) {
    const word = wordAround(caret.node, caret.offset, side);
    if (word && pointOnWord(word, x, y)) return word;
  }
  return null;
}
