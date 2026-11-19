/**
 * One orthogonal route between two anchors, round what is in the way.
 *
 * The space is cut into a sparse grid: a line at each side of every
 * obstacle (grown by a clearance) and at each end's stub. Any shortest
 * right-angled path between the stubs can be drawn along those lines, so
 * the search (A* over grid crossings, with a cost for every bend) finds a
 * path that never enters an obstacle whenever one exists, and is the same
 * every time for the same input. It is pure: rectangles in, points out.
 *
 * The grid has two lines per obstacle and axis, so the work depends on how
 * many things are near the two ends, not on how many the board holds.
 */
import type { Point, Rect } from '../model/geometry';
import type { Side } from '../model/types';

/** How far a route keeps from anything it goes round, in world units. */
export const CLEARANCE = 14;
/** How far a route runs straight out of a port before it may turn. */
export const STUB = 18;
/** What a bend costs, in world units of extra length the route would rather travel than turn. */
const BEND = 36;

export interface Anchor {
  /** The object the end is stuck to, or null for a free point. */
  rect: Rect | null;
  /** Where on the object's outline (or the free point itself). */
  point: Point;
  /** The side it leaves from. Null for a free point: any direction. */
  side: Side | null;
}

const NORMAL: Record<Side, Point> = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 } };
/** Directions as grid steps: 0 east, 1 south, 2 west, 3 north. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const DIR_OF: Record<Side, number> = { e: 0, s: 1, w: 2, n: 3 };

const stubOf = (anchor: Anchor): Point => (anchor.side ? { x: anchor.point.x + NORMAL[anchor.side].x * STUB, y: anchor.point.y + NORMAL[anchor.side].y * STUB } : anchor.point);

function uniqueSorted(values: number[]): number[] {
  values.sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of values) if (out.length === 0 || value - out[out.length - 1] > 0.01) out.push(value);
  return out;
}

/** The index of `value` in a sorted list that holds it (to within rounding). */
function indexOf(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value - 0.01) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Drop points that lie on the straight line between their neighbours, and repeats. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    if (b && Math.abs(b.x - p.x) < 0.01 && Math.abs(b.y - p.y) < 0.01) continue;
    if (a && b && ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** The plain route when nothing is in the way, or when there is no way round: out, across, in. */
function direct(from: Anchor, to: Anchor): Point[] {
  const a = stubOf(from);
  const b = stubOf(to);
  const horizontalFirst = from.side ? from.side === 'e' || from.side === 'w' : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const toHorizontal = to.side ? to.side === 'e' || to.side === 'w' : !horizontalFirst;
  let middle: Point[];
  if (horizontalFirst && toHorizontal) {
    const x = (a.x + b.x) / 2;
    middle = [{ x, y: a.y }, { x, y: b.y }];
  } else if (!horizontalFirst && !toHorizontal) {
    const y = (a.y + b.y) / 2;
    middle = [{ x: a.x, y }, { x: b.x, y }];
  } else if (horizontalFirst) {
    middle = [{ x: b.x, y: a.y }];
  } else {
    middle = [{ x: a.x, y: b.y }];
  }
  return simplify([from.point, a, ...middle, b, to.point]);
}

/** A small binary heap of states, lowest cost first; ties go to the one pushed first, so the answer never wavers. */
class Heap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];
  private readonly order: number[] = [];
  private pushed = 0;

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    let i = this.keys.length;
    this.keys.push(key);
    this.values.push(value);
    this.order.push(this.pushed++);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.values[0];
    const last = this.keys.length - 1;
    this.swap(0, last);
    this.keys.pop();
    this.values.pop();
    this.order.pop();
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < this.keys.length && this.less(left, best)) best = left;
      if (right < this.keys.length && this.less(right, best)) best = right;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.order[a] < this.order[b]);
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
    [this.order[a], this.order[b]] = [this.order[b], this.order[a]];
  }
}

/**
 * The points of an orthogonal route from one anchor to the other, first and
 * last being the anchors' own points. `obstacles` are rectangles the route
 * must not enter; the two end objects are kept clear of by themselves and
 * need not be listed. When no route clears everything (an end boxed in),
 * the plain out-across-in route is returned: a line is always drawn.
 */
export function routeOrthogonal(from: Anchor, to: Anchor, obstacles: readonly Rect[]): Point[] {
  const start = stubOf(from);
  const goal = stubOf(to);
  const blocks: Rect[] = [];
  const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 });
  const inside = (r: Rect, p: Point): boolean => p.x > r.x + 0.01 && p.x < r.x + r.w - 0.01 && p.y > r.y + 0.01 && p.y < r.y + r.h - 0.01;
  // The end objects themselves, a little less grown than the stub is long, so the stubs stand clear of them.
  for (const end of [from.rect, to.rect]) if (end) blocks.push(grow(end, CLEARANCE - 2));
  for (const obstacle of obstacles) {
    const grown = grow(obstacle, CLEARANCE);
    // Something an end sits inside or right against cannot be gone round; it is not in the way of this route.
    if (inside(grown, start) || inside(grown, goal)) continue;
    blocks.push(grown);
  }
  if (blocks.some((block) => inside(block, start) || inside(block, goal))) return direct(from, to);

  const xs = uniqueSorted([start.x, goal.x, ...blocks.flatMap((b) => [b.x, b.x + b.w])]);
  const ys = uniqueSorted([start.y, goal.y, ...blocks.flatMap((b) => [b.y, b.y + b.h])]);
  const nx = xs.length;
  const ny = ys.length;
  // Which steps between neighbouring crossings pass through a block.
  const hBlocked = new Uint8Array(nx * ny);
  const vBlocked = new Uint8Array(nx * ny);
  for (const block of blocks) {
    const x0 = indexOf(xs, block.x);
    const x1 = indexOf(xs, block.x + block.w);
    const y0 = indexOf(ys, block.y);
    const y1 = indexOf(ys, block.y + block.h);
    for (let iy = y0 + 1; iy < y1; iy++) for (let ix = x0; ix < x1; ix++) hBlocked[iy * nx + ix] = 1;
    for (let ix = x0 + 1; ix < x1; ix++) for (let iy = y0; iy < y1; iy++) vBlocked[iy * nx + ix] = 1;
  }

  const sx = indexOf(xs, start.x);
  const sy = indexOf(ys, start.y);
  const gx = indexOf(xs, goal.x);
  const gy = indexOf(ys, goal.y);
  const startDir = from.side ? DIR_OF[from.side] : -1;
  // The route must arrive travelling into the target: against its side's outward direction.
  const goalDir = to.side ? (DIR_OF[to.side] + 2) % 4 : -1;

  // A state is a crossing and the direction it was reached in (4 for the start, reached in none).
  const states = nx * ny * 5;
  const cost = new Float64Array(states).fill(Infinity);
  const prev = new Int32Array(states).fill(-1);
  const heap = new Heap();
  const first = (sy * nx + sx) * 5 + 4;
  cost[first] = 0;
  heap.push(Math.abs(xs[gx] - xs[sx]) + Math.abs(ys[gy] - ys[sy]), first);
  let found = -1;
  while (heap.size) {
    const state = heap.pop();
    const node = Math.floor(state / 5);
    const dir = state % 5;
    const ix = node % nx;
    const iy = Math.floor(node / nx);
    if (ix === gx && iy === gy) {
      found = state;
      break;
    }
    const here = cost[state];
    for (let d = 0; d < 4; d++) {
      if (dir !== 4 && (d + 2) % 4 === dir) continue; // never straight back
      const jx = ix + DX[d];
      const jy = iy + DY[d];
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      if (d === 0 ? hBlocked[iy * nx + ix] : d === 2 ? hBlocked[iy * nx + jx] : d === 1 ? vBlocked[iy * nx + ix] : vBlocked[jy * nx + ix]) continue;
      let step = Math.abs(xs[jx] - xs[ix]) + Math.abs(ys[jy] - ys[iy]);
      if (dir === 4) {
        // Leaving the stub in any direction but straight on is a bend like any other.
        if (startDir !== -1 && d !== startDir) step += BEND;
      } else if (d !== dir) step += BEND;
      if (jx === gx && jy === gy && goalDir !== -1 && d !== goalDir) step += BEND;
      const next = (jy * nx + jx) * 5 + d;
      const total = here + step;
      if (total >= cost[next] - 1e-9) continue;
      cost[next] = total;
      prev[next] = state;
      heap.push(total + Math.abs(xs[gx] - xs[jx]) + Math.abs(ys[gy] - ys[jy]), next);
    }
  }
  if (found === -1) return direct(from, to);
  const path: Point[] = [];
  for (let state = found; state !== -1; state = prev[state]) {
    const node = Math.floor(state / 5);
    path.push({ x: xs[node % nx], y: ys[Math.floor(node / nx)] });
  }
  path.reverse();
  return simplify([from.point, ...path, to.point]);
}

/** Whether a polyline passes through the inside of a rectangle. */
export function routeEnters(points: readonly Point[], r: Rect): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (x1 > r.x + 0.01 && x0 < r.x + r.w - 0.01 && y1 > r.y + 0.01 && y0 < r.y + r.h - 0.01) return true;
  }
  return false;
}
