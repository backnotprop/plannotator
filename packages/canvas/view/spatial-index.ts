/**
 * A uniform grid over the world: which objects might be in this rectangle?
 * Answers in time that depends on what is near the rectangle, not on how
 * many objects the canvas holds. Culling and hit-testing both ask it.
 *
 * A grid, not a tree: objects on a board are roughly even in size, inserts
 * and moves are constant time (a drag updates it every frame), and there is
 * nothing to rebalance. An object larger than `MAX_CELLS` cells (a frame
 * around half the board) is kept in a short list checked on every query
 * instead of being written into thousands of cells.
 */
import { type Rect, rectsIntersect } from '../model/geometry';

const MAX_CELLS = 256;

export class SpatialIndex {
  private readonly cells = new Map<string, Set<string>>();
  private readonly rects = new Map<string, Rect>();
  private readonly large = new Set<string>();

  constructor(private readonly cellSize = 400) {}

  get size(): number {
    return this.rects.size;
  }

  has(id: string): boolean {
    return this.rects.has(id);
  }

  rectOf(id: string): Rect | undefined {
    return this.rects.get(id);
  }

  private span(r: Rect): { x0: number; y0: number; x1: number; y1: number; count: number } {
    const s = this.cellSize;
    const x0 = Math.floor(r.x / s);
    const y0 = Math.floor(r.y / s);
    const x1 = Math.floor((r.x + r.w) / s);
    const y1 = Math.floor((r.y + r.h) / s);
    return { x0, y0, x1, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  }

  /** Add an object, or move it when it is already here. */
  set(id: string, r: Rect): void {
    const before = this.rects.get(id);
    if (before) {
      if (before.x === r.x && before.y === r.y && before.w === r.w && before.h === r.h) return;
      this.delete(id);
    }
    this.rects.set(id, { x: r.x, y: r.y, w: r.w, h: r.h });
    const span = this.span(r);
    if (span.count > MAX_CELLS) {
      this.large.add(id);
      return;
    }
    for (let cx = span.x0; cx <= span.x1; cx++) {
      for (let cy = span.y0; cy <= span.y1; cy++) {
        const key = `${cx},${cy}`;
        let cell = this.cells.get(key);
        if (!cell) this.cells.set(key, (cell = new Set()));
        cell.add(id);
      }
    }
  }

  delete(id: string): void {
    const r = this.rects.get(id);
    if (!r) return;
    this.rects.delete(id);
    if (this.large.delete(id)) return;
    const span = this.span(r);
    for (let cx = span.x0; cx <= span.x1; cx++) {
      for (let cy = span.y0; cy <= span.y1; cy++) {
        const key = `${cx},${cy}`;
        const cell = this.cells.get(key);
        if (!cell) continue;
        cell.delete(id);
        if (cell.size === 0) this.cells.delete(key);
      }
    }
  }

  clear(): void {
    this.cells.clear();
    this.rects.clear();
    this.large.clear();
  }

  /** Ids of every object whose rect overlaps `area`. Each id once, no set order. */
  query(area: Rect): string[] {
    const out: string[] = [];
    const span = this.span(area);
    if (span.count > this.cells.size + 64) {
      // The area covers more cells than exist: walk the objects instead.
      for (const [id, r] of this.rects) if (overlaps(r, area)) out.push(id);
      return out;
    }
    const seen = new Set<string>();
    for (let cx = span.x0; cx <= span.x1; cx++) {
      for (let cy = span.y0; cy <= span.y1; cy++) {
        const cell = this.cells.get(`${cx},${cy}`);
        if (!cell) continue;
        for (const id of cell) {
          if (seen.has(id)) continue;
          seen.add(id);
          if (overlaps(this.rects.get(id)!, area)) out.push(id);
        }
      }
    }
    for (const id of this.large) if (overlaps(this.rects.get(id)!, area)) out.push(id);
    return out;
  }
}

/**
 * Overlap that also counts a rect with no width or no height (a perfectly
 * horizontal arrow has a height of 0 and must still be found).
 */
function overlaps(r: Rect, area: Rect): boolean {
  if (r.w === 0 || r.h === 0) {
    return r.x <= area.x + area.w && area.x <= r.x + r.w && r.y <= area.y + area.h && area.y <= r.y + r.h;
  }
  return rectsIntersect(r, area);
}
