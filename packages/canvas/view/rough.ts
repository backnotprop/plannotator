/**
 * The sketch look: an outline drawn as if by hand, and hatching instead of
 * a flat fill. It marks one object as "proposed, not decided".
 *
 * Everything is worked out from a seed, so an object looks the same every
 * time it is drawn, on every screen, and does not shimmer when the board
 * moves. The result is path strings: the browser scales them, so they stay
 * crisp at any zoom and cost nothing after they are made. (Never an SVG
 * filter: that is rastered every frame, blurs when zoomed and cannot be
 * seeded per object.)
 *
 * The method is the well-known one (rough.js, Excalidraw): a straight side
 * becomes two strokes that do not quite agree, each bowed a little and
 * overshooting its ends; a curve is drawn twice with its handles nudged;
 * hatching is a scan-line fill of the outline, turned to an angle.
 */
import type { Point } from '../model/geometry';
import type { Seg } from './shape-outline';

/** A small seeded generator: the same seed gives the same numbers. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed made from an id, so an object needs no seed of its own to be drawn the same every time. */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

const n = (value: number): string => String(Math.round(value * 10) / 10);

/** One hand-drawn pass along a straight line: bowed, with the ends a little off. */
function strokeLine(a: Point, b: Point, wobble: number, random: () => number): string {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 0.5) return '';
  // Longer lines wander more, up to a point; short ones must not turn into scribbles.
  const off = Math.min(wobble, length / 12);
  const jitter = () => (random() - 0.5) * 2 * off;
  const nx = -(b.y - a.y) / length;
  const ny = (b.x - a.x) / length;
  const bow = (random() - 0.5) * off * 1.6;
  const over = Math.min(3, length * 0.03) * random();
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const x0 = a.x - ux * over + jitter();
  const y0 = a.y - uy * over + jitter();
  const x1 = b.x + ux * over + jitter();
  const y1 = b.y + uy * over + jitter();
  const c1x = a.x + (b.x - a.x) * 0.5 + nx * bow + jitter();
  const c1y = a.y + (b.y - a.y) * 0.5 + ny * bow + jitter();
  const c2x = a.x + (b.x - a.x) * 0.75 + nx * bow + jitter();
  const c2y = a.y + (b.y - a.y) * 0.75 + ny * bow + jitter();
  return `M${n(x0)} ${n(y0)}C${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(x1)} ${n(y1)}`;
}

/** One hand-drawn pass along a curve: the same curve with every point nudged. */
function strokeCurve(a: Point, c: [number, number, number, number, number, number], wobble: number, random: () => number): string {
  const span = Math.hypot(c[4] - a.x, c[5] - a.y);
  const off = Math.min(wobble * 0.7, span / 10);
  const j = () => (random() - 0.5) * 2 * off;
  return `M${n(a.x + j())} ${n(a.y + j())}C${n(c[0] + j())} ${n(c[1] + j())} ${n(c[2] + j())} ${n(c[3] + j())} ${n(c[4] + j())} ${n(c[5] + j())}`;
}

/**
 * An outline (or any run of segments) as hand-drawn strokes: one path
 * string holding two passes. `rough` 0 is nearly straight, 2 is loose.
 */
export function roughStrokes(segs: readonly Seg[], rough: 0 | 1 | 2, seed: number): string {
  const random = seeded(seed);
  const wobble = [0.5, 1.4, 2.6][rough];
  let d = '';
  for (let pass = 0; pass < 2; pass++) {
    let at: Point = { x: 0, y: 0 };
    let start: Point = at;
    for (const seg of segs) {
      if (seg[0] === 'M') {
        at = { x: seg[1], y: seg[2] };
        start = at;
      } else if (seg[0] === 'L') {
        d += strokeLine(at, { x: seg[1], y: seg[2] }, wobble, random);
        at = { x: seg[1], y: seg[2] };
      } else if (seg[0] === 'C') {
        d += strokeCurve(at, [seg[1], seg[2], seg[3], seg[4], seg[5], seg[6]], wobble, random);
        at = { x: seg[5], y: seg[6] };
      } else {
        d += strokeLine(at, start, wobble, random);
        at = start;
      }
    }
  }
  return d;
}

/** A route's points as hand-drawn strokes. */
export function roughLine(points: readonly Point[], rough: 0 | 1 | 2, seed: number): string {
  const segs: Seg[] = points.map((p, i) => (i === 0 ? ['M', p.x, p.y] : ['L', p.x, p.y]));
  return roughStrokes(segs, rough, seed);
}

/** A closed outline as a polygon: curves are walked in short steps. */
export function flatten(segs: readonly Seg[], steps = 8): Point[] {
  const out: Point[] = [];
  let at: Point = { x: 0, y: 0 };
  for (const seg of segs) {
    if (seg[0] === 'M' || seg[0] === 'L') {
      at = { x: seg[1], y: seg[2] };
      out.push(at);
    } else if (seg[0] === 'C') {
      const [, x1, y1, x2, y2, x, y] = seg;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        out.push({ x: u * u * u * at.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, y: u * u * u * at.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y });
      }
      at = { x, y };
    }
  }
  return out;
}

/**
 * Hatching inside a polygon: parallel lines `gap` apart at `angle`
 * (degrees), each a little unsteady. One path string. Lines are found by
 * turning the polygon so the hatch runs level, cutting it with level lines,
 * and turning the pieces back.
 */
export function hachure(polygon: readonly Point[], gap: number, angle: number, seed: number): string {
  if (polygon.length < 3) return '';
  const random = seeded(seed ^ 0x9e3779b9);
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const turned = polygon.map((p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }));
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of turned) {
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  let d = '';
  for (let y = y0 + gap * 0.6; y < y1; y += gap) {
    const crossings: number[] = [];
    for (let i = 0; i < turned.length; i++) {
      const a = turned[i];
      const b = turned[(i + 1) % turned.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const xa = crossings[i] + 1.5;
      const xb = crossings[i + 1] - 1.5;
      if (xb - xa < 2) continue;
      const ya = y + (random() - 0.5) * 1.2;
      const yb = y + (random() - 0.5) * 1.2;
      // Turned back to where the shape really is.
      d += `M${n(xa * cos - ya * sin)} ${n(xa * sin + ya * cos)}L${n(xb * cos - yb * sin)} ${n(xb * sin + yb * cos)}`;
    }
  }
  return d;
}
