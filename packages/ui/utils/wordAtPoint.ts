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

const joinsWords = (text: string, i: number): boolean =>
  JOINER.test(text[i] ?? '') && WORD_CHAR.test(text[i - 1] ?? '') && WORD_CHAR.test(text[i + 1] ?? '');

export function wordSpanAt(text: string, index: number, useSegmenter = true): [number, number] | null {
  if (index < 0 || index >= text.length) return null;
  const seg = useSegmenter ? getSegmenter() : null;
  if (seg) {
    const words: [number, number][] = [];
    for (const s of seg.segment(text)) if (s.isWordLike) words.push([s.index, s.index + s.segment.length]);
    const at = (i: number) => words.find(([from, to]) => i >= from && i < to) ?? null;
    const first = at(index) ?? (joinsWords(text, index) ? at(index - 1) : null);
    if (!first) return null;
    let [start, end] = first;
    for (let next = joinsWords(text, end) ? at(end + 1) : null; next; next = joinsWords(text, end) ? at(end + 1) : null) end = next[1];
    for (let prev = joinsWords(text, start - 1) ? at(start - 2) : null; prev; prev = joinsWords(text, start - 1) ? at(start - 2) : null) start = prev[0];
    const splits = (i: number) => /[.:]/.test(text[i] ?? '') && !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? ''));
    if (splits(index)) return null;
    for (let i = index - 1; i >= start; i -= 1) if (splits(i)) { start = i + 1; break; }
    for (let i = index + 1; i < end; i += 1) if (splits(i)) { end = i; break; }
    return [start, end];
  }
  const isWordChar = (i: number) => WORD_CHAR.test(text[i] ?? '');
  const inWord = (i: number) => isWordChar(i) || joinsWords(text, i);
  if (!inWord(index)) return null;
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

export function pointOnWord(word: WordBounds, x: number, y: number, slop = 1): boolean {
  return Array.from(wordRange(word).getClientRects()).some(
    (r) => x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop,
  );
}

export function wordAtPoint(x: number, y: number): WordBounds | null {
  const caret = caretAtPoint(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null;
  for (const side of [1, -1] as const) {
    const word = wordAround(caret.node, caret.offset, side);
    if (word && pointOnWord(word, x, y)) return word;
  }
  return null;
}
