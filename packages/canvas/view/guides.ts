/**
 * Alignment guides while something is dragged: when an edge or the middle
 * of what is moving comes close to an edge or the middle of something
 * nearby, it settles there (a soft snap) and a line shows what it lined up
 * with, with the distance between the two. Pure: rectangles in, an
 * adjustment and the lines to draw out.
 */
import type { Rect } from '../model/geometry';

export interface Guide {
  /** `x`: a vertical line at world x = `at`. `y`: a horizontal line at world y = `at`. */
  axis: 'x' | 'y';
  at: number;
  /** How far the line runs along the other axis: across both things it lines up. */
  from: number;
  to: number;
  /** The clear distance between the two, measured along the line, and where to write it. Absent when they overlap. */
  gap?: { distance: number; at: number };
}

export interface Snap {
  /** How far to nudge what is moving so it sits on the guides. */
  dx: number;
  dy: number;
  guides: Guide[];
}

const stops = (r: Rect, axis: 'x' | 'y'): number[] => (axis === 'x' ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.y, r.y + r.h / 2, r.y + r.h]);

function nearest(moving: Rect, others: readonly Rect[], axis: 'x' | 'y', tolerance: number): { shift: number; other: Rect; at: number } | null {
  let best: { shift: number; other: Rect; at: number } | null = null;
  const mine = stops(moving, axis);
  for (const other of others) {
    for (const theirs of stops(other, axis)) {
      for (const own of mine) {
        const shift = theirs - own;
        if (Math.abs(shift) > tolerance) continue;
        // The smallest move wins; between equal ones, the first found, so the choice does not flicker.
        if (!best || Math.abs(shift) < Math.abs(best.shift) - 1e-6) best = { shift, other, at: theirs };
      }
    }
  }
  return best;
}

function guideFor(moved: Rect, hit: { other: Rect; at: number }, axis: 'x' | 'y'): Guide {
  const { other } = hit;
  // The line runs along the other axis, from the far end of one to the far end of the other.
  const a0 = axis === 'x' ? moved.y : moved.x;
  const a1 = axis === 'x' ? moved.y + moved.h : moved.x + moved.w;
  const b0 = axis === 'x' ? other.y : other.x;
  const b1 = axis === 'x' ? other.y + other.h : other.x + other.w;
  const guide: Guide = { axis, at: hit.at, from: Math.min(a0, b0), to: Math.max(a1, b1) };
  const gapStart = Math.min(a1, b1);
  const gapEnd = Math.max(a0, b0);
  if (gapEnd > gapStart + 0.5) guide.gap = { distance: Math.round(gapEnd - gapStart), at: (gapStart + gapEnd) / 2 };
  return guide;
}

/**
 * Where `moving` should settle among `others`, each axis by itself.
 * `tolerance` is how close counts, in world units (a few screen pixels over
 * the zoom).
 */
export function snapToGuides(moving: Rect, others: readonly Rect[], tolerance: number): Snap {
  const x = nearest(moving, others, 'x', tolerance);
  const y = nearest(moving, others, 'y', tolerance);
  const dx = x?.shift ?? 0;
  const dy = y?.shift ?? 0;
  const moved = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  const guides: Guide[] = [];
  if (x) guides.push(guideFor(moved, x, 'x'));
  if (y) guides.push(guideFor(moved, y, 'y'));
  return { dx, dy, guides };
}
