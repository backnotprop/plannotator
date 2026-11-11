import { compositeOver, contrastRatio, mixOklab, quantize, toHex, type RgbColor } from '../../utils/cssColor';

export const SHAPE_SHARP_HAIR_MIN = 3;
export const SHAPE_SHARP_WIRE_MIN = 5;
export const SHAPE_SHARP_EDGE_MIN = 3;

export const SHAPE_SHARP_ZONES = ['blue', 'amber', 'green', 'plum', 'alert'] as const;
export type ShapeSharpZone = (typeof SHAPE_SHARP_ZONES)[number];

/** The board variables this reads, without their `--`. */
export const SHAPE_SHARP_COLOR_NAMES = [
  'background', 'paper', 'surface', 'ink',
  'shp-hair', 'shp-wire',
  ...SHAPE_SHARP_ZONES.flatMap((z) => [z, `${z}-soft`, `shp-zone-${z}`] as const),
] as const;
export type ShapeSharpColorName = (typeof SHAPE_SHARP_COLOR_NAMES)[number];
/** The board's colours as the page resolved them (any alpha). */
export type ShapeSharpColors = Record<ShapeSharpColorName, RgbColor>;

const WHITE: RgbColor = { r: 1, g: 1, b: 1, a: 1 };
const STEPS = 50;

const over = (c: RgbColor, ground: RgbColor) => quantize(compositeOver(c, ground));
const ratio = (c: RgbColor, ground: RgbColor) => contrastRatio(over(c, ground), ground);
/** What a line must reach on `ground`: the bar, or what the ink reaches there when that is less. */
const bar = (min: number, ink: RgbColor, ground: RgbColor) => Math.min(min, contrastRatio(ink, ground));

function toward(from: RgbColor, to: RgbColor, holds: (c: RgbColor) => boolean): RgbColor | null {
  for (let i = 1; i <= STEPS; i++) {
    const c = quantize(mixOklab(from, to, i / STEPS));
    if (holds(c)) return c;
  }
  return null;
}

export function shapeSharpGrounds(c: ShapeSharpColors) {
  const paper = over(c.paper, over(c.background, WHITE));
  const surface = over(c.surface, paper);
  const soft = Object.fromEntries(SHAPE_SHARP_ZONES.map((z) => [z, over(c[`${z}-soft`], paper)])) as Record<ShapeSharpZone, RgbColor>;
  return { paper, surface, ink: over(c.ink, paper), soft };
}

/** Empty when the palette holds, so a palette that passes renders exactly as the CSS draws it. */
export function shapeSharpFixes(c: ShapeSharpColors): Record<string, string> {
  const fixes: Record<string, string> = {};
  const g = shapeSharpGrounds(c);
  const { paper, ink } = g;
  const softs = SHAPE_SHARP_ZONES.map((z) => g.soft[z]);
  const hold = (name: string, now: RgbColor, grounds: RgbColor[], min: number, ways: RgbColor[]) => {
    const holds = (x: RgbColor) => grounds.every((ground) => ratio(x, ground) >= bar(min, ink, ground) - 1e-9);
    const start = over(now, paper);
    if (holds(start)) return;
    let fixed: RgbColor | null = null;
    for (const to of ways) if (!fixed) fixed = toward(start, to, holds);
    fixes[name] = toHex(fixed ?? ink);
  };
  hold('--shp-hair', c['shp-hair'], [paper, g.surface, ...softs], SHAPE_SHARP_HAIR_MIN, [ink]);
  hold('--shp-wire', c['shp-wire'], [paper, ...softs], SHAPE_SHARP_WIRE_MIN, [ink]);
  for (const z of SHAPE_SHARP_ZONES) hold(`--shp-zone-${z}`, c[`shp-zone-${z}`], [paper, g.soft[z]], SHAPE_SHARP_EDGE_MIN, [over(c[z], paper), ink]);
  return fixes;
}
