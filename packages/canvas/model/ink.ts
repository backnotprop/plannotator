/**
 * A line drawn by hand (`InkObject`). It is a placed object like any other:
 * a box, and inside it the line as points measured across that box, 0 to 1
 * each way. Moving it changes `x` and `y`, resizing it changes `w` and `h`,
 * and neither touches the points, so the commands and events that carry a
 * box carry a drawing with nothing new.
 *
 * This file is the arithmetic: making the stored form from points on the
 * board, and reading it back. Nothing here draws.
 */
import { type Point, type Rect, distanceToSegment } from './geometry';
import type { InkObject, InkPen } from './types';

/** How wide each pen draws, in board units. The stroke is centred on the line, so it reaches half of this past the object's box. */
export const PEN_WIDTH: Readonly<Record<InkPen, number>> = { fine: 2, marker: 4.5, highlighter: 18 };

/** The rect a drawn line covers: its box and the half pen's width its stroke reaches past it on every side. */
export function inkBounds(ink: Pick<InkObject, 'pen'> & Rect): Rect {
  const reach = PEN_WIDTH[ink.pen ?? 'marker'] / 2;
  return { x: ink.x - reach, y: ink.y - reach, w: ink.w + reach * 2, h: ink.h + reach * 2 };
}

/** The most points a stored line holds. The same number as `LIMITS.inkPoints` (the codec imports nothing from here). */
export const INK_MAX_POINTS = 1000;

/** A stored point keeps four decimal places: a ten-thousandth of its box, under a pixel on any box a board holds. */
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/** The line in board coordinates, in the order drawn. */
export function inkPoints(ink: Pick<InkObject, 'points'> & Rect): Point[] {
  const out: Point[] = [];
  for (let i = 0; i + 1 < ink.points.length; i += 2) out.push({ x: ink.x + ink.points[i] * ink.w, y: ink.y + ink.points[i + 1] * ink.h });
  return out;
}

/** How far a board point is from a drawn line. Nothing is allocated: the pointer asks this as it moves. */
export function distanceToInk(p: Point, ink: Pick<InkObject, 'points'> & Rect): number {
  const { points, x, y, w, h } = ink;
  let best = Infinity;
  let ax = x + points[0] * w;
  let ay = y + points[1] * h;
  for (let i = 2; i + 1 < points.length; i += 2) {
    const bx = x + points[i] * w;
    const by = y + points[i + 1] * h;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
    const d = Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy));
    if (d < best) best = d;
    ax = bx;
    ay = by;
  }
  return best;
}

/**
 * The same line with fewer points: a point nearer than `tolerance` to the
 * line between its kept neighbours is dropped (Ramer, Douglas and Peucker).
 * The first and the last point are always kept, and every kept point is one
 * that was given.
 */
export function simplifyLine(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  // A list of spans still to look at, not recursion: a line of any length cannot run out of stack.
  const spans: number[] = [0, points.length - 1];
  while (spans.length) {
    const last = spans.pop()!;
    const first = spans.pop()!;
    let far = -1;
    let reach = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i], points[first], points[last]);
      if (d > reach) {
        reach = d;
        far = i;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    spans.push(first, far, far, last);
  }
  return points.filter((_, i) => keep[i]);
}

/** At most `most` of the points, taken evenly along the line, the first and the last among them. */
function thin(points: readonly Point[], most: number): readonly Point[] {
  if (points.length <= most) return points;
  return Array.from({ length: most }, (_, i) => points[Math.round((i * (points.length - 1)) / (most - 1))]);
}

/**
 * What a drawn line is stored as: the box round it and the points across
 * that box. This is what a pen calls with what the pointer gave it, and
 * what anyone calls who has a line in board coordinates. Null when there is
 * no line to keep: fewer than two usable points, or all of them in one
 * place (a tap is not a drawing).
 *
 * Points that are not finite numbers are left out. However many are given,
 * at most `INK_MAX_POINTS` are kept and the work is bounded: the line is
 * first thinned evenly, then simplified by shape, harder each time until it
 * fits, then thinned evenly again (a line that is all corners cannot be
 * simplified by shape).
 */
export function strokeFromPoints(drawn: readonly Point[], tolerance = 1): (Rect & { points: number[] }) | null {
  const usable = drawn.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  const source = thin(usable, INK_MAX_POINTS * 2);
  const base = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1;
  let line: readonly Point[] = simplifyLine(source, base);
  for (let wider = base * 2; line.length > INK_MAX_POINTS && wider <= base * 16; wider *= 2) line = simplifyLine(source, wider);
  line = thin(line, INK_MAX_POINTS);
  if (line.length < 2) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of line) {
    if (p.x < left) left = p.x;
    if (p.y < top) top = p.y;
    if (p.x > right) right = p.x;
    if (p.y > bottom) bottom = p.y;
  }
  if (right - left < 1 && bottom - top < 1) return null;
  // A dead straight line still needs a box with some size to be an object at all.
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  const points: number[] = [];
  for (const p of line) points.push(round((p.x - left) / w), round((p.y - top) / h));
  return { x: left, y: top, w, h, points };
}
