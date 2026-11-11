/** Holds a drawn board's colours to WCAG contrast in every palette. */
import { compositeOver, contrastRatio, mixOklab, parseCssColor, quantize, relativeLuminance, rgbToOklch, toHex, withOklchLightness, type RgbColor } from '../../utils/cssColor';

export const SHAPE_TEXT_MIN = 4.5;
export const SHAPE_GRAPHIC_MIN = 3;

export const SHAPE_ZONES = ['blue', 'green', 'amber', 'plum'] as const;
const SOFTS = [...SHAPE_ZONES, 'alert'] as const;

/** The board variables this reads, without their `--`. */
export const SHAPE_COLOR_NAMES = [
  'background', 'paper', 'surface', 'ink', 'ink2', 'grey', 'mark', 'mark-soft', 'alert', 'alert-soft',
  'blue', 'blue-soft', 'green', 'green-soft', 'amber', 'amber-soft', 'plum', 'plum-soft',
] as const;
export type ShapeColorName = (typeof SHAPE_COLOR_NAMES)[number];
/** The board's colours as the page resolved them (any alpha). */
export type ShapeColors = Record<ShapeColorName, RgbColor>;

const WHITE: RgbColor = { r: 1, g: 1, b: 1, a: 1 };
const STEPS = 50;
const DARK_BELOW = 0.179;

const on = (c: RgbColor, ground: RgbColor) => contrastRatio(quantize(compositeOver(c, ground)), ground);
const rgba = (c: RgbColor) =>
  c.a >= 1 ? toHex(quantize(c)) : `rgba(${[c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(', ')}, ${Math.round(c.a * 1000) / 1000})`;

function grounds(c: ShapeColors) {
  const paper = quantize(compositeOver(c.paper, compositeOver(c.background, WHITE)));
  return { paper, surface: quantize(compositeOver(c.surface, paper)), markSoft: quantize(compositeOver(c['mark-soft'], paper)), ink: quantize(compositeOver(c.ink, paper)) };
}

/** What `x` must reach on `ground`: the bar, or what the ink reaches there when that is less. */
const bar = (min: number, ink: RgbColor, ground: RgbColor) => Math.min(min, on(ink, ground));

function fade(x: RgbColor, to: RgbColor, holds: (c: RgbColor) => boolean): RgbColor {
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const c = { ...mixOklab(x, to, t), a: x.a + (1 - x.a) * t };
    if (holds(c)) return c;
  }
  return { ...to, a: 1 };
}

/**
 * `x` made lighter or darker toward the OKLCH lightness `L`, its hue and chroma kept (so a blue
 * stays a blue, a zone stays tinted), until `holds`; null if even `L` does not hold.
 */
function shade(x: RgbColor, L: number, holds: (c: RgbColor) => boolean): RgbColor | null {
  const from = rgbToOklch(x).L;
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const c = { ...withOklchLightness(x, from + (L - from) * t), a: x.a + (1 - x.a) * t };
    if (holds(c)) return c;
  }
  return null;
}

/**
 * The board variables (with `--`) whose resolved colour falls short of the rule, each with the
 * colour to use instead.
 */
export function shapeContrastFixes(c: ShapeColors): Record<string, string> {
  const fixes: Record<string, string> = {};
  const g = grounds(c);
  const { paper, ink } = g;
  const dark = relativeLuminance(paper) < DARK_BELOW;
  // The -soft fills first: the ink must read on them.
  const soft = {} as Record<(typeof SOFTS)[number], RgbColor>;
  for (const z of SOFTS) {
    let s = quantize(compositeOver(c[`${z}-soft`], paper));
    const need = Math.min(bar(SHAPE_TEXT_MIN, ink, paper), on(ink, g.surface));
    if (on(ink, s) < need) {
      const holds = (x: RgbColor) => on(ink, quantize(x)) >= need;
      s = quantize(shade(s, dark ? 0 : 1, holds) ?? fade(s, paper, holds));
      fixes[`--${z}-soft`] = toHex(s);
    }
    soft[z] = s;
  }
  const all = [g.paper, g.surface, ...SOFTS.map((z) => soft[z])];
  const words: [ShapeColorName, RgbColor[]][] = [
    ...SHAPE_ZONES.map((z) => [z, [g.paper, soft[z], g.surface]] as [ShapeColorName, RgbColor[]]),
    ['alert', all],
    ['mark', [...all, ...all.map((ground) => quantize(compositeOver(c['mark-soft'], ground)))]],
    ['grey', all],
    ['ink2', all],
  ];
  for (const [name, on_] of words) {
    const holds = (x: RgbColor) => on_.every((ground) => on(x, ground) >= bar(SHAPE_TEXT_MIN, ink, ground));
    if (holds(c[name])) continue;
    fixes[`--${name}`] = rgba(shade(c[name], dark ? 1 : 0, holds) ?? fade(c[name], ink, holds));
  }
  return fixes;
}

/** Whether the board's paper is dark (the luminance at which black and white words contrast equally). */
export function shapeBoardIsDark(c: ShapeColors): boolean {
  return relativeLuminance(grounds(c).paper) < DARK_BELOW;
}

/**
 * A logo's colour for this board: null when it holds (or the board is light), else its colour
 * made lighter, its hue kept, until it reaches 3:1 on the paper.
 */
export function shapeLogoFill(logo: RgbColor, c: ShapeColors, fixes: Record<string, string> = {}): string | null {
  if (!shapeBoardIsDark(c)) return null;
  const g = grounds(c);
  const softs = SOFTS.map((z) => parseCssColor(fixes[`--${z}-soft`]) ?? quantize(compositeOver(c[`${z}-soft`], g.paper)));
  const ground = [g.paper, g.surface, ...softs];
  const holds = (x: RgbColor) => ground.every((gr) => on(x, gr) >= bar(SHAPE_GRAPHIC_MIN, g.ink, gr));
  if (holds(logo)) return null;
  return toHex(quantize(shade({ ...logo, a: 1 }, 1, holds) ?? fade({ ...logo, a: 1 }, g.ink, holds)));
}
