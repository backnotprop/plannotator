/**
 * The outline of each box shape, as segments. One source for three uses:
 * the clean renderer turns the segments into an SVG path, the sketch
 * renderer feeds the same segments to the rough generator, and the still
 * picture of a snapshot draws them too. Pure numbers: no DOM.
 *
 * A shape is drawn in its own box, from (0, 0) to (w, h).
 */
import type { BoxShape } from '../model/types';

export type Seg = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];

export interface ShapeOutline {
  /** The closed outline: what is filled, and what is stroked. */
  outline: Seg[];
  /** Further lines drawn over the fill, open or closed: a cylinder's rim, a container's lanes, an actor's limbs. */
  details: Seg[][];
  /** Where words go, as insets from the box: top, right, bottom, left. */
  text: [number, number, number, number];
}

/** How far a cubic's handle sits from its end to draw a quarter of an ellipse. */
const K = 0.5523;

function roundRect(w: number, h: number, radius: number): Seg[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const k = r * (1 - K);
  return [
    ['M', r, 0],
    ['L', w - r, 0],
    ['C', w - k, 0, w, k, w, r],
    ['L', w, h - r],
    ['C', w, h - k, w - k, h, w - r, h],
    ['L', r, h],
    ['C', k, h, 0, h - k, 0, h - r],
    ['L', 0, r],
    ['C', 0, k, k, 0, r, 0],
    ['Z'],
  ];
}

/** Half an ellipse from (x0, y) to (x1, y), in either direction, bulging by `ry` (negative bulges up). */
function halfEllipseX(x0: number, x1: number, y: number, ry: number): Seg[] {
  const mid = (x0 + x1) / 2;
  const rx = (x1 - x0) / 2;
  return [
    ['C', x0, y + ry * K, mid - rx * K, y + ry, mid, y + ry],
    ['C', mid + rx * K, y + ry, x1, y + ry * K, x1, y],
  ];
}

/** Half an ellipse from (x, y0) to (x, y1), in either direction, bulging by `rx` (negative bulges left). */
function halfEllipseY(y0: number, y1: number, x: number, rx: number): Seg[] {
  const mid = (y0 + y1) / 2;
  const ry = (y1 - y0) / 2;
  return [
    ['C', x + rx * K, y0, x + rx, mid - ry * K, x + rx, mid],
    ['C', x + rx, mid + ry * K, x + rx * K, y1, x, y1],
  ];
}

const CLOUD: [number, number, number, number, number, number][] = [
  [0.06, 0.95, 0, 0.8, 0, 0.68],
  [0, 0.52, 0.1, 0.42, 0.22, 0.42],
  [0.22, 0.18, 0.4, 0.02, 0.58, 0.02],
  [0.74, 0.02, 0.86, 0.14, 0.88, 0.3],
  [0.96, 0.32, 1, 0.44, 1, 0.6],
  [1, 0.8, 0.9, 0.95, 0.76, 0.95],
];

/** The header of a container, and the strip down its left side that holds lane names. */
export const CONTAINER_HEADER = 34;
export const CONTAINER_STRIP = 24;
/** The room under an actor's figure for its name. */
export const ACTOR_LABEL = 26;

export function shapeOutline(shape: BoxShape, w: number, h: number, lanes = 0): ShapeOutline {
  switch (shape) {
    case 'process':
      return { outline: roundRect(w, h, 9), details: [], text: [8, 14, 8, 14] };
    case 'pill':
      return { outline: roundRect(w, h, h / 2), details: [], text: [6, Math.min(24, h / 2), 6, Math.min(24, h / 2)] };
    case 'decision':
      return {
        outline: [['M', w / 2, 0], ['L', w, h / 2], ['L', w / 2, h], ['L', 0, h / 2], ['Z']],
        details: [],
        text: [h * 0.22, w * 0.2, h * 0.22, w * 0.2],
      };
    case 'database': {
      const ry = Math.max(6, Math.min(h * 0.14, 18));
      return {
        outline: [['M', 0, ry], ...halfEllipseX(0, w, ry, -ry), ['L', w, h - ry], ...halfEllipseX(w, 0, h - ry, ry), ['Z']],
        details: [[['M', 0, ry], ...halfEllipseX(0, w, ry, ry)]],
        text: [ry * 2 + 4, 12, ry + 4, 12],
      };
    }
    case 'queue': {
      const rx = Math.max(6, Math.min(w * 0.1, 16));
      return {
        outline: [['M', rx, 0], ['L', w - rx, 0], ...halfEllipseY(0, h, w - rx, rx), ['L', rx, h], ...halfEllipseY(h, 0, rx, -rx), ['Z']],
        details: [[['M', w - rx, 0], ...halfEllipseY(0, h, w - rx, -rx)]],
        text: [6, rx * 2 + 8, 6, rx + 8],
      };
    }
    case 'document': {
      const a = Math.max(6, Math.min(h * 0.14, 14));
      return {
        outline: [['M', 0, 0], ['L', w, 0], ['L', w, h - a], ['C', w * 0.72, h - a * 2.4, w * 0.52, h + a * 0.9, w * 0.26, h - a * 0.1], ['C', w * 0.16, h - a * 0.5, w * 0.07, h - a * 0.4, 0, h - a * 0.1], ['Z']],
        details: [],
        text: [8, 12, a * 1.6 + 4, 12],
      };
    }
    case 'cloud': {
      const outline: Seg[] = [['M', 0.25 * w, 0.95 * h]];
      for (const [a, b, c, d, e, f] of CLOUD) outline.push(['C', a * w, b * h, c * w, d * h, e * w, f * h]);
      outline.push(['Z']);
      return { outline, details: [], text: [h * 0.34, w * 0.16, h * 0.14, w * 0.14] };
    }
    case 'actor': {
      const figure = Math.max(24, h - ACTOR_LABEL);
      const r = Math.min(w, figure) * 0.16;
      const cx = w / 2;
      const neck = r * 2 + 1;
      const hip = figure * 0.66;
      const arm = neck + (hip - neck) * 0.32;
      const span = Math.min(w / 2 - 4, figure * 0.34);
      return {
        // The outline is the head: the one part that is filled.
        outline: [['M', cx - r, r + 1], ['C', cx - r, r + 1 - r * K * 2, cx + r, r + 1 - r * K * 2, cx + r, r + 1], ['C', cx + r, r + 1 + r * K * 2, cx - r, r + 1 + r * K * 2, cx - r, r + 1], ['Z']],
        details: [
          [['M', cx, neck], ['L', cx, hip]],
          [['M', cx - span, arm], ['L', cx + span, arm]],
          [['M', cx, hip], ['L', cx - span * 0.8, figure - 1]],
          [['M', cx, hip], ['L', cx + span * 0.8, figure - 1]],
        ],
        text: [figure, 0, 0, 0],
      };
    }
    case 'container': {
      const details: Seg[][] = [[['M', 0, CONTAINER_HEADER], ['L', w, CONTAINER_HEADER]]];
      if (lanes > 0) {
        details.push([['M', CONTAINER_STRIP, CONTAINER_HEADER], ['L', CONTAINER_STRIP, h]]);
        const each = (h - CONTAINER_HEADER) / lanes;
        for (let i = 1; i < lanes; i++) details.push([['M', 0, CONTAINER_HEADER + each * i], ['L', w, CONTAINER_HEADER + each * i]]);
      }
      return { outline: roundRect(w, h, 8), details, text: [0, 12, h - CONTAINER_HEADER, 14] };
    }
  }
}

const n = (value: number): string => String(Math.round(value * 100) / 100);

/** Segments as an SVG path. */
export function toPath(segs: readonly Seg[]): string {
  let out = '';
  for (const seg of segs) out += seg[0] === 'Z' ? 'Z' : `${seg[0]}${seg.slice(1).map((v) => n(v as number)).join(' ')}`;
  return out;
}

/** The points an arrow may attach to: the middle of each side of the box. */
export function shapePorts(w: number, h: number): Record<'n' | 'e' | 's' | 'w', { x: number; y: number }> {
  return { n: { x: w / 2, y: 0 }, e: { x: w, y: h / 2 }, s: { x: w / 2, y: h }, w: { x: 0, y: h / 2 } };
}
