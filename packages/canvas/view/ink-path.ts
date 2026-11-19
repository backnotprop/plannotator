/**
 * A drawn line as an SVG path. The stored points are joined by curves that
 * pass through the middle of each pair, so a line simplified to a few
 * points still reads as one movement of the hand, with no corners of its
 * own. Pure: numbers in, a string out.
 */
import type { InkPen } from '../model/types';

/** How wide each pen draws, in board units. */
export const PEN_WIDTH: Readonly<Record<InkPen, number>> = { fine: 2, marker: 4.5, highlighter: 18 };
/** A highlighter is see-through, so what it goes over is still read. */
export const HIGHLIGHTER_OPACITY = 0.4;

const n = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * Paths already made, by the points they were made from. Moving a drawing
 * makes a new object that shares the old one's `points`, so a drag reuses
 * the string; only a resize or new points make another.
 */
const PATHS = new WeakMap<readonly number[], { w: number; h: number; d: string }>();

/** The path of a line whose points are measured across a box `w` by `h`, in that box's own coordinates. */
export function inkPath(points: readonly number[], w: number, h: number): string {
  const kept = PATHS.get(points);
  if (kept && kept.w === w && kept.h === h) return kept.d;
  const count = points.length >> 1;
  let d = '';
  if (count >= 2) {
    const x = (i: number) => points[i * 2] * w;
    const y = (i: number) => points[i * 2 + 1] * h;
    d = `M${n(x(0))} ${n(y(0))}`;
    if (count > 2) {
      d += `L${n((x(0) + x(1)) / 2)} ${n((y(0) + y(1)) / 2)}`;
      for (let i = 1; i < count - 1; i++) d += `Q${n(x(i))} ${n(y(i))} ${n((x(i) + x(i + 1)) / 2)} ${n((y(i) + y(i + 1)) / 2)}`;
    }
    d += `L${n(x(count - 1))} ${n(y(count - 1))}`;
  }
  PATHS.set(points, { w, h, d });
  return d;
}
