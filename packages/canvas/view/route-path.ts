/**
 * Drawing a route: rounded elbows, small arcs where a line hops over
 * another, the place for its label, and the direction of each end. Pure:
 * points in, an SVG path string and a few numbers out.
 */
import type { Point } from '../model/geometry';

/** How round an elbow is, and how wide a hop, in world units. */
export const ELBOW_RADIUS = 6;
export const HOP_RADIUS = 4.5;

const n = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * Where horizontal runs of these routes cross vertical runs of others: for
 * each route, the x of every hop on each of its segments. The later route
 * in the list hops over the earlier, so which line gives way never flips.
 * Only for routes on screen; the lists are in the order the routes are given.
 */
export function findHops(routes: readonly (readonly Point[])[]): Map<number, number[]>[] {
  // Every vertical run, sorted by x, so a horizontal run looks only at the ones between its two ends.
  const verticals: { x: number; y0: number; y1: number; route: number }[] = [];
  routes.forEach((points, route) => {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) > 0.01) verticals.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), route });
    }
  });
  verticals.sort((a, b) => a.x - b.x);
  const xs = verticals.map((v) => v.x);
  const firstAtOrAfter = (x: number): number => {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return routes.map((points, route) => {
    const hops = new Map<number, number[]>();
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (Math.abs(a.y - b.y) > 0.01) continue;
      const x0 = Math.min(a.x, b.x) + ELBOW_RADIUS + HOP_RADIUS;
      const x1 = Math.max(a.x, b.x) - ELBOW_RADIUS - HOP_RADIUS;
      if (x1 <= x0) continue;
      const found: number[] = [];
      for (let v = firstAtOrAfter(x0); v < verticals.length && verticals[v].x <= x1; v++) {
        const other = verticals[v];
        // Only over a route earlier in the list, and only where the two really cross (not where they meet at an end).
        if (other.route >= route || a.y <= other.y0 + 0.5 || a.y >= other.y1 - 0.5) continue;
        if (found.length === 0 || other.x - found[found.length - 1] > HOP_RADIUS * 2 + 1) found.push(other.x);
      }
      if (found.length) hops.set(i, found);
    }
    return hops;
  });
}

/** The route as an SVG path: straight runs, round elbows, and an arc at each hop. */
export function routePath(points: readonly Point[], hops?: Map<number, number[]>): string {
  if (points.length < 2) return '';
  let d = `M${n(points[0].x)} ${n(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const next = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    // Where this run ends: short of the corner by the elbow's radius, when there is a corner.
    let end = b;
    let radius = 0;
    if (next) {
      radius = Math.min(ELBOW_RADIUS, length / 2, Math.hypot(next.x - b.x, next.y - b.y) / 2);
      end = { x: b.x - ((b.x - a.x) / length) * radius, y: b.y - ((b.y - a.y) / length) * radius };
    }
    const over = hops?.get(i);
    if (over) {
      const forward = b.x > a.x;
      for (const x of forward ? over : [...over].reverse()) {
        const before = forward ? x - HOP_RADIUS : x + HOP_RADIUS;
        const after = forward ? x + HOP_RADIUS : x - HOP_RADIUS;
        d += `L${n(before)} ${n(a.y)}A${HOP_RADIUS} ${HOP_RADIUS} 0 0 ${forward ? 1 : 0} ${n(after)} ${n(a.y)}`;
      }
    }
    d += `L${n(end.x)} ${n(end.y)}`;
    if (next && radius > 0) {
      const out = Math.hypot(next.x - b.x, next.y - b.y);
      d += `Q${n(b.x)} ${n(b.y)} ${n(b.x + ((next.x - b.x) / out) * radius)} ${n(b.y + ((next.y - b.y) / out) * radius)}`;
    }
  }
  return d;
}

/** The point a share of the way along a route (0 its start, 1 its end), and whether the run there is horizontal. */
export function pointAlong(points: readonly Point[], share: number): { x: number; y: number; horizontal: boolean } {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  let left = total * Math.max(0, Math.min(1, share));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= length || i === points.length - 1) {
      const t = length ? Math.min(1, left / length) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, horizontal: Math.abs(b.y - a.y) < Math.abs(b.x - a.x) };
    }
    left -= length;
  }
  return { x: points[0].x, y: points[0].y, horizontal: true };
}

/** The angle a route arrives at its end by, and leaves its start by (pointing outward from the line), in radians. */
export function endAngles(points: readonly Point[]): { start: number; end: number } {
  const last = points.length - 1;
  return {
    start: Math.atan2(points[0].y - points[1].y, points[0].x - points[1].x),
    end: Math.atan2(points[last].y - points[last - 1].y, points[last].x - points[last - 1].x),
  };
}

/** How near a point is to a polyline. */
export function distanceToRoute(p: Point, points: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}
