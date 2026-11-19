/**
 * Plain geometry in world units. No DOM, no React: everything here runs in a
 * server, a worker or a test as it does in the page.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** A rect from two corners in any order (a marquee drag goes any direction). */
export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export const rectCenter = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Touching edges do not count: two boxes side by side do not overlap. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** The smallest rect holding every given rect, or null for none. */
export function unionRects(rects: Iterable<Rect>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function expandRect(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Distance from a point to the segment a→b. Arrows are hit-tested with it. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Where the ray from a rect's centre towards `towards` leaves the rect. An
 * arrow bound to an object starts on its edge, not in its middle. A target
 * inside the rect (or on its centre) gives the centre.
 */
export function rectEdgeToward(r: Rect, towards: Point): Point {
  const c = rectCenter(r);
  const dx = towards.x - c.x;
  const dy = towards.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const tx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx);
  const ty = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy);
  const t = Math.min(tx, ty);
  if (t >= 1) return c;
  return { x: c.x + dx * t, y: c.y + dy * t };
}

export const isFiniteRect = (r: Rect): boolean =>
  Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) && r.w >= 0 && r.h >= 0;
