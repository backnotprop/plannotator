/**
 * How a picked colour becomes a row (approval "inbox-tag-colors-picker", NOTES.md "How a pick becomes a row"). The
 * pick is read as OKLCH: its hue is kept and part of its chroma; the row's lightness is set per theme from how vivid
 * and how light the pick is, held inside the band where a row's text keeps 4.5:1 in every state (plain, hover,
 * selected, selected under the pointer) on the default theme. Below 0.03 chroma (black, white, greys) there is no hue
 * to keep and the row is grey. The window draws the row relative to the theme's card (threadTags.css), so `delta` is
 * the row's lightness less the default theme's card (1 in light, 0.22 in dark).
 *
 * Also the square's colour model: a traditional HSV square (left to right saturation, top to bottom brightness).
 */

/** Per theme: L = base + depth·s + nudge·(t − 0.5), held to [min, max]; chroma min(k·Cp, cap) within sRGB in every state. */
export const TINT_BANDS = {
  light: { card: 1, base: 0.965, depth: -0.105, nudge: 0.03, min: 0.845, max: 0.97, k: 0.6, cap: 0.15, steps: [0, -0.015, -0.03, -0.042] },
  dark: { card: 0.22, base: 0.255, depth: 0.05, nudge: 0.012, min: 0.245, max: 0.315, k: 0.55, cap: 0.12, steps: [0, 0.01, 0.02, 0.028] },
} as const;
export type TintMode = keyof typeof TINT_BANDS;

/** A grey row's chroma and hue (the default theme's own blue-grey). */
const GREY_C = 0.006;
const GREY_H = 260;

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** `#rrggbb` in OKLCH (lightness 0 to 1, chroma, hue in degrees). */
export function hexToOklch(hex: string): { l: number; c: number; h: number } {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(n.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/** OKLCH as linear sRGB, unclipped. */
export function oklchToLinear(L: number, C: number, H: number): [number, number, number] {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (L: number, C: number, H: number): boolean => oklchToLinear(L, C, H).every((v) => v >= 0 && v <= 1);

/** An OKLCH colour as `#rrggbb`, clipped into sRGB. */
export function oklchToHex(L: number, C: number, H: number): string {
  return `#${oklchToLinear(L, C, H)
    .map((v) =>
      Math.round(toGamma(Math.max(0, Math.min(1, v))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** A row in one theme: its lightness less the default card's (`delta`), chroma, and the four states' lightness. */
export interface TintRow {
  delta: number;
  c: number;
  /** Plain, hover, selected, selected under the pointer, on the default theme. */
  ls: number[];
}

/** A pick's row in both themes, and its hue; `grey` when the pick has no hue to keep. */
export interface TintLook {
  light: TintRow;
  dark: TintRow;
  h: number;
  grey: boolean;
}

function rowIn(mode: TintMode, Lp: number, Cp: number, h: number, grey: boolean): TintRow {
  const band = TINT_BANDS[mode];
  const s = Math.min(1, Cp / 0.2);
  const t = Math.max(0, Math.min(1, (Lp - 0.35) / 0.6));
  const L = Math.round(Math.max(band.min, Math.min(band.max, band.base + band.depth * s + band.nudge * (t - 0.5))) * 10000) / 10000;
  const ls = band.steps.map((step) => L + step);
  // Chroma: what the pick carries, then as much as sRGB shows at every state's lightness (so no state is clipped).
  let c = Math.floor((grey ? GREY_C : Math.min(band.k * Cp, band.cap)) * 1000) / 1000;
  while (c > 0 && !ls.every((l) => inGamut(l, c, h))) c = Math.round((c - 0.001) * 1000) / 1000;
  return { delta: Math.round((L - band.card) * 10000) / 10000, c: Math.max(0, c), ls };
}

/** How a `#rrggbb` pick becomes a row, light and dark. */
export function tintLook(hex: string): TintLook {
  const { l, c, h } = hexToOklch(hex);
  const grey = c < 0.03;
  const hue = grey ? GREY_H : Math.round(h * 10) / 10;
  return { light: rowIn('light', l, c, hue, grey), dark: rowIn('dark', l, c, hue, grey), h: hue, grey };
}

/** HSV (hue 0–360, saturation and brightness 0–1) as `#rrggbb`. */
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)]
    .map((x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** `#rrggbb` as HSV (hue 0–360, saturation and brightness 0–1). A grey's hue is 0. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

/** WCAG contrast of two `#rrggbb`. */
export function contrastOf(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = hex.replace('#', '');
    const [r, g, bl] = [0, 2, 4].map((i) => toLinear(parseInt(n.slice(i, i + 2), 16) / 255)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
