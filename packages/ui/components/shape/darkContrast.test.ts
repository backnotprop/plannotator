/**
 * `darkContrast`'s rule (approval shape-any-picture, the owner's "poor contrast in dark mode"). What regresses if
 * these fail:
 * - a light board is touched at all (it must look exactly as without the opt-in);
 * - on a dark board a box's border sinks into its zone, a zone's edge into the paper (WCAG 1.4.11, 3:1), or a box's
 *   fill into its zone;
 * - holding the structure costs a word: the ink or grey on a box falls below what it had (up to 7:1);
 * - a palette that already holds is changed anyway, or a zone's edge loses its zone's hue.
 * The palettes are the frame's own formulas (ShapeDrawn's SHAPE_FRAME_CSS) over real theme tokens.
 */
import { describe, expect, test } from 'bun:test';
import { contrast, mixOklab, shapeDarkFixes, SHAPE_DARK_ZONES, type Rgb, type ShapeDarkColors, type ShapeDarkZone } from './darkContrast';

const hex = (h: string): Rgb => [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16)) as unknown as Rgb;
/** An `oklch(L C h)` token in sRGB. */
function oklch(L: number, C: number, h: number): string {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const g = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  return `#${lin.map((v) => g(v).toString(16).padStart(2, '0')).join('')}`;
}

/** A board's colours as the frame mixes them from a theme's tokens. */
function board(t: { paper: string; ink: string; surface: string; rule: string; grey: string; alert: string }): ShapeDarkColors {
  const paper = hex(t.paper), ink = hex(t.ink), alert = hex(t.alert);
  const hues: Record<ShapeDarkZone, [string, number, number]> = {
    blue: ['#2f6fb0', 0.74, 0.13],
    amber: ['#d9971f', 0.76, 0.16],
    green: ['#2b8a57', 0.74, 0.13],
    plum: ['#9b3f78', 0.74, 0.12],
    alert: [t.alert, 1, 0.11],
  };
  const zones = {} as Record<ShapeDarkZone, Rgb>, fills = {} as Record<ShapeDarkZone, Rgb>;
  for (const z of SHAPE_DARK_ZONES) {
    const [h, line, fill] = hues[z];
    zones[z] = z === 'alert' ? alert : mixOklab(ink, hex(h), line);
    fills[z] = mixOklab(paper, hex(h), fill);
  }
  return { paper, ink, surface: hex(t.surface), rule: hex(t.rule), grey: hex(t.grey), zones, fills };
}

// The Inbox's default theme (plannotator, dark and light), tokyo-night and plannotator-modern, dark: themes/*.css.
const DARK = board({ paper: oklch(0.15, 0.02, 260), ink: oklch(0.9, 0.01, 260), surface: oklch(0.22, 0.02, 260), rule: oklch(0.35, 0.02, 260), grey: oklch(0.72, 0.02, 260), alert: oklch(0.65, 0.2, 25) });
const LIGHT = board({ paper: oklch(0.97, 0.005, 260), ink: oklch(0.18, 0.02, 260), surface: oklch(1, 0, 0), rule: oklch(0.88, 0.01, 260), grey: oklch(0.4, 0.02, 260), alert: oklch(0.5, 0.25, 25) });
const TOKYO_DARK = board({ paper: '#24283b', ink: '#c0caf5', surface: '#1d202f', rule: '#414868', grey: '#787c99', alert: '#f7768e' });
const MODERN_DARK = board({ paper: '#000000', ink: '#f2f2f2', surface: '#2a2a2a', rule: '#414141', grey: '#bbbbbb', alert: '#ff0000' });

function holds(c: ShapeDarkColors) {
  const f = shapeDarkFixes(c)!;
  const surface = f.surface ?? c.surface, rule = f.rule ?? c.rule, grey = f.grey ?? c.grey;
  for (const z of SHAPE_DARK_ZONES) {
    const fill = c.fills[z];
    expect(contrast(rule, fill)).toBeGreaterThanOrEqual(3);
    expect(contrast(f.edges[z], c.paper)).toBeGreaterThanOrEqual(3);
    expect(contrast(f.edges[z], fill)).toBeGreaterThanOrEqual(3);
    expect(contrast(surface, fill)).toBeGreaterThanOrEqual(1.25);
  }
  expect(contrast(rule, c.paper)).toBeGreaterThanOrEqual(3);
  expect(contrast(rule, surface)).toBeGreaterThanOrEqual(3);
  expect(contrast(surface, c.paper)).toBeGreaterThanOrEqual(1.25);
  // Words keep what they had on a box, up to 7:1.
  expect(contrast(c.ink, surface)).toBeGreaterThanOrEqual(Math.min(7, contrast(c.ink, c.surface)));
  expect(contrast(grey, surface)).toBeGreaterThanOrEqual(Math.min(7, contrast(c.grey, c.surface)) - 0.01);
  return f;
}

describe('darkContrast', () => {
  test('a light board gets nothing', () => {
    expect(shapeDarkFixes(LIGHT)).toBeNull();
    // Nor one whose paper reads as black because it is see-through: dark words are a light board.
    expect(shapeDarkFixes({ ...LIGHT, paper: [0, 0, 0] })).toBeNull();
  });

  test('a dark board that sinks today: borders, zone edges and boxes hold, and no word loses contrast', () => {
    // As drawn today, a box's border and fill vanish into the amber zone.
    expect(contrast(DARK.rule, DARK.fills.amber)).toBeLessThan(2);
    expect(contrast(DARK.surface, DARK.fills.amber)).toBeLessThan(1.25);
    const f = holds(DARK);
    expect(f.rule && f.surface).toBeTruthy();
    holds(TOKYO_DARK);
    holds(MODERN_DARK);
  });

  test('each zone keeps its own hue on its edge', () => {
    const { edges } = shapeDarkFixes(DARK)!;
    const [r, , b] = edges.blue;
    expect(b).toBeGreaterThan(r + 30);
    expect(edges.amber[0]).toBeGreaterThan(edges.amber[2] + 30);
    expect(edges.green[1]).toBeGreaterThan(edges.green[0] + 20);
  });

  test('a dark palette that already holds is left as it is', () => {
    const strong: ShapeDarkColors = { ...DARK, surface: hex('#3a3a3a'), rule: hex('#a0a0a0'), grey: hex('#c8c8c8') };
    const f = holds(strong);
    expect([f.surface, f.rule, f.grey]).toEqual([undefined, undefined, undefined]);
  });
});
