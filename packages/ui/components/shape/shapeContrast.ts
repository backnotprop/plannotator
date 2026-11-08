/**
 * Holds a drawn board's colours to WCAG contrast in every palette.
 *
 * `SHAPE_FRAME_CSS` derives the board's colours from the theme tokens: the
 * zone colours (`--blue`, `--green`, `--amber`, `--plum`) are a hue mixed
 * toward the ink, their `-soft` fills the hue mixed into the paper, and the
 * words colours (`--mark`, `--alert`, `--grey`, `--ink2`) are the palette's
 * own primary, destructive and muted foreground. That holds on the default
 * palette, but not on all of them: a dark palette whose paper is lighter
 * (Dracula, Everforest) or a light one whose primary is pale (Tinacious, Min)
 * leaves words in those colours under 4.5:1. And a product logo keeps its own
 * colour, so a dark one (SQLite, PayPal, Prisma) vanishes on a dark board.
 *
 * `shapeContrastFixes` takes the colours the page resolved and returns only
 * the ones that fall short, each made lighter (dark board) or darker (light
 * board) just far enough, its hue and chroma kept, so a blue zone stays blue.
 * A `-soft` fill moves the other way (away from the ink) so the zone stays
 * tinted. A colour that already holds is not in the result, so a palette that
 * passes renders exactly as the CSS draws it.
 * Nothing is asked to beat the palette's own ink: where the ink itself reads
 * under 4.5:1 on a ground (Solarized's low-contrast text), the bar there is
 * what the ink reaches.
 *
 * The rule, every pair at or above `SHAPE_TEXT_MIN` (4.5:1, words are drawn in
 * all of these colours):
 * - each zone colour on the paper, its own `-soft` fill and the surface (a
 *   chip's words, an icon, a drawn thing's outline; the paper's words on a
 *   filled chip are the same pair);
 * - `--alert` on the paper, the surface and every `-soft` fill;
 * - `--mark` on the paper, the surface and every `-soft` fill, and on
 *   `--mark-soft` over each of them (a chip in a zone);
 * - `--grey` and `--ink2` on the paper, the surface and every `-soft` fill;
 * - the ink on every `-soft` fill (or what it reaches on the palette's own
 *   card, the surface, when that is less: Solarized's zones stay visible).
 * On a dark board a logo's colour is held to `SHAPE_GRAPHIC_MIN` (3:1) on the
 * paper, the surface and every `-soft` fill (`shapeLogoFill`). On a light board
 * logos keep their colours: the approved light boards show them as they are.
 *
 * Pure and browser-free, so the rule is tested per shipped palette.
 */
import { compositeOver, contrastRatio, mixOklab, parseCssColor, quantize, relativeLuminance, rgbToOklch, toHex, withOklchLightness, type RgbColor } from '../../utils/cssColor';

export const SHAPE_TEXT_MIN = 4.5;
export const SHAPE_GRAPHIC_MIN = 3;

export const SHAPE_ZONES = ['blue', 'green', 'amber', 'plum'] as const;
const SOFTS = [...SHAPE_ZONES, 'alert'] as const;

/** The board variables this reads, without their `--`. `background` is what shows through a see-through paper. */
export const SHAPE_COLOR_NAMES = [
  'background', 'paper', 'surface', 'ink', 'ink2', 'grey', 'mark', 'mark-soft', 'alert', 'alert-soft',
  'blue', 'blue-soft', 'green', 'green-soft', 'amber', 'amber-soft', 'plum', 'plum-soft',
] as const;
export type ShapeColorName = (typeof SHAPE_COLOR_NAMES)[number];
/** The board's colours as the page resolved them (any alpha). */
export type ShapeColors = Record<ShapeColorName, RgbColor>;

const WHITE: RgbColor = { r: 1, g: 1, b: 1, a: 1 };
const STEPS = 50;
/** The paper luminance at which black and white words contrast equally: below it the board is dark. */
const DARK_BELOW = 0.179;

/** The ratio a colour (any alpha) shows on an opaque ground, as the 8-bit colour the page paints. */
const on = (c: RgbColor, ground: RgbColor) => contrastRatio(quantize(compositeOver(c, ground)), ground);
const rgba = (c: RgbColor) =>
  c.a >= 1 ? toHex(quantize(c)) : `rgba(${[c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(', ')}, ${Math.round(c.a * 1000) / 1000})`;

/** The opaque grounds a board's words are drawn on (a see-through paper shows the background). */
function grounds(c: ShapeColors) {
  // As the page paints them: 8-bit.
  const paper = quantize(compositeOver(c.paper, compositeOver(c.background, WHITE)));
  return { paper, surface: quantize(compositeOver(c.surface, paper)), markSoft: quantize(compositeOver(c['mark-soft'], paper)), ink: quantize(compositeOver(c.ink, paper)) };
}

/** What `x` must reach on `ground`: the bar, or what the ink reaches there when that is less. */
const bar = (min: number, ink: RgbColor, ground: RgbColor) => Math.min(min, on(ink, ground));

/** `x` mixed toward `to` until `holds`, in small steps; the first step that holds, else `to`. */
function fade(x: RgbColor, to: RgbColor, holds: (c: RgbColor) => boolean): RgbColor {
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    // A see-through colour (the ink at 80%) also becomes more solid.
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
 * The board variables (with `--`) whose resolved colour falls short of the rule, each with
 * the colour to use instead. Empty when the palette holds.
 */
export function shapeContrastFixes(c: ShapeColors): Record<string, string> {
  const fixes: Record<string, string> = {};
  const g = grounds(c);
  const { paper, ink } = g;
  const dark = relativeLuminance(paper) < DARK_BELOW;
  // The -soft fills first: the ink must read on them. A fill that falls short moves away from the
  // ink (lighter on a light board, darker on a dark one), tinted still; else it fades toward the paper.
  const soft = {} as Record<(typeof SOFTS)[number], RgbColor>;
  for (const z of SOFTS) {
    let s = quantize(compositeOver(c[`${z}-soft`], paper));
    // A zone is a ground like the palette's own card: it need not beat what the ink reaches there.
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
    // What is wrong, and the accent, are drawn anywhere on a board: on every ground, and the accent on its own chip on each.
    ['alert', all],
    ['mark', [...all, ...all.map((ground) => quantize(compositeOver(c['mark-soft'], ground)))]],
    ['grey', all],
    ['ink2', all],
  ];
  for (const [name, on_] of words) {
    const holds = (x: RgbColor) => on_.every((ground) => on(x, ground) >= bar(SHAPE_TEXT_MIN, ink, ground));
    if (holds(c[name])) continue;
    // Darker on a light board, lighter on a dark one, its hue kept; the ink's own colour as the last resort.
    fixes[`--${name}`] = rgba(shade(c[name], dark ? 1 : 0, holds) ?? fade(c[name], ink, holds));
  }
  return fixes;
}

/** Whether the board's paper is dark (the luminance at which black and white words contrast equally). */
export function shapeBoardIsDark(c: ShapeColors): boolean {
  return relativeLuminance(grounds(c).paper) < DARK_BELOW;
}

/**
 * A logo's colour for this board: null when it holds (or the board is light), else its colour made
 * lighter, its hue kept, until it reaches 3:1 on the paper, the surface and every `-soft` fill (as `fixes` leaves them).
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
