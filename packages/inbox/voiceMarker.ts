/**
 * Where the dim "Transcribing…" marker goes in the mirror layer. It is paint that adds no width, so it can't wrap as
 * text does: this places it as a word would land, from the caret's place in the page. Pure, so the edges are tested
 * without a layout engine.
 */

/** Its gap from the caret, as `.ib-vph i`'s `left: 3px`. */
const GAP = 3;

export interface MarkerRoom {
  /** The caret's x, and the middle of its line, in page pixels. */
  x: number;
  mid: number;
  word: number;
  line: number;
  /** The field's text box across: inside its padding, which keeps words clear of the buttons over the box. */
  left: number;
  right: number;
  /** Where the field clips, below. */
  bottom: number;
  /** The caret's line runs right to left, so the words go on at its left. */
  rtl: boolean;
  /** No text on the line below the caret. */
  nextFree: boolean;
}

/** Offsets from the caret (`top` adds to the marker's own lift), or `none`: the still caret stands in. */
export type MarkerPlace = { kind: 'line' | 'next'; left: number; top: number } | { kind: 'none' };

export function placeMarker(room: MarkerRoom): MarkerPlace {
  const { x, word, rtl } = room;
  if (rtl ? x - GAP - word >= room.left - 0.5 : x + GAP + word <= room.right + 0.5) return { kind: 'line', left: rtl ? -GAP - word : GAP, top: 0 };
  const below = room.mid + room.line * 1.5 <= room.bottom;
  if (room.nextFree && below && word <= room.right - room.left) return { kind: 'next', left: rtl ? room.right - word - x : room.left - x, top: room.line };
  return { kind: 'none' };
}

export const samePlace = (a: MarkerPlace, b: MarkerPlace): boolean =>
  a.kind === b.kind && (a.kind === 'none' || b.kind === 'none' || (Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5));
