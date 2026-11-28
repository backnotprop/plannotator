/**
 * A tag row's four fills on a given theme (review of #3553, M2): the approved mapping (tagColourMap.ts, NOTES.md) is
 * the target, read relative to the theme's own card, and every state is held so the row's text is never harder to
 * read than that theme's plain row in the same state, and keeps 4.5:1 wherever the plain row does. Pure: the window
 * feeds it the live theme's colours (tagTintSheet.ts), the tests feed it every theme file.
 *
 * How: the target fill of each state is the card's lightness moved by the approved delta and step, at the pick's hue
 * and carried chroma (fitted into sRGB at that lightness). A state whose text would fall under its floor keeps the hue
 * and chroma and moves in lightness, the least it takes, toward the side where contrast grows (on a light card with
 * dark text, lighter; on a dark card with light text, deeper). Where no lightness can hold (a white card whose text is
 * already under AA), that state is the plain fill. The default theme holds every target, so it draws exactly the
 * approved table.
 */
import { hexToOklch, oklchToHex, oklchToLinear, TINT_BANDS, tintLook } from './tagColourMap';

export type Rgb = readonly [number, number, number];

/** What a row's colour depends on: the card, the two text colours rows use, and the plain row's four fills. */
export interface TintTheme {
  card: Rgb;
  fg: Rgb;
  muted: Rgb;
  /** The plain (untinted) row: at rest, hover, selected, selected under the pointer; opaque, over the card. */
  plain: readonly [Rgb, Rgb, Rgb, Rgb];
}

/** The text contrast every theme is held to where its own plain row has it. */
export const TINT_AA = 4.5;

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const luminance = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export const hexRgb = (hex: string): Rgb => {
  const n = hex.replace('#', '');
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
};
export const rgbHex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** `top` (alpha 0–1) painted over `under`, as the browser blends: in sRGB. */
export function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(top[i]! * alpha + under[i]! * (1 - alpha))) as unknown as Rgb;
}

/** The plain row's fills as the Inbox draws them by default (inbox.css: hover the muted fill at 45%, selection the accent at 15/19% dark, 10/14% light). */
export function plainFills(card: Rgb, mutedFill: Rgb, primary: Rgb, light: boolean): [Rgb, Rgb, Rgb, Rgb] {
  return [card, over(mutedFill, 0.45, card), over(primary, light ? 0.1 : 0.15, card), over(primary, light ? 0.14 : 0.19, card)];
}

/** The floor each state's text must keep: the plain row's own contrast there, capped at AA. */
function floors(theme: TintTheme): number[][] {
  return theme.plain.map((p) => [theme.fg, theme.muted].map((t) => Math.min(TINT_AA, contrast(t, p))));
}

/**
 * A pick's target on this theme's card: the approved mapping's lightness against the card (tagColourMap.ts
 * `tintLook`) and each state's step, the hue, and the chroma the pick carries (fitted per state, at the lightness it
 * is drawn at, by `fill`).
 */
function target(hex: string, theme: TintTheme): { ls: number[]; c: number; h: number } {
  const card = hexToOklch(rgbHex(theme.card)).l;
  const mode = luminance(theme.fg) < luminance(theme.card) ? 'light' : 'dark';
  const band = TINT_BANDS[mode];
  const look = tintLook(hex);
  const carried = look.grey ? look[mode].c : Math.min(band.k * hexToOklch(hex).c, band.cap);
  return { ls: band.steps.map((step) => Math.max(0, Math.min(1, card + look[mode].delta + step))), c: carried, h: look.h };
}

/** The fill at a lightness: the chroma, cut to what sRGB shows there (so nothing is clipped by the browser). */
function fill(L: number, c: number, h: number): Rgb {
  let cc = c;
  while (cc > 0 && !oklchToLinear(L, cc, h).every((v) => v >= 0 && v <= 1)) cc = Math.max(0, cc - 0.002);
  return hexRgb(oklchToHex(L, cc, h));
}

/** Whether a fill keeps both text colours at their floor in this state. */
const holds = (f: Rgb, theme: TintTheme, floor: readonly number[]) => contrast(theme.fg, f) >= floor[0]! && contrast(theme.muted, f) >= floor[1]!;

/**
 * One state's fill: the target if its text holds; else the same hue and chroma moved in lightness, the least it takes
 * to hold (luminance rises with lightness, so the lightnesses that hold are one side of a bound, found by halving);
 * the plain fill if even that cannot.
 */
function stateFill(L: number, c: number, h: number, theme: TintTheme, floor: readonly number[], plain: Rgb): Rgb {
  const goal = fill(L, c, h);
  if (holds(goal, theme, floor)) return goal;
  // Toward the side where contrast grows: away from the text colours (both sit on one side of the row).
  const up = luminance(theme.fg) < luminance(goal);
  let ok = up ? 1 : 0;
  let bad = L;
  if (!holds(fill(ok, c, h), theme, floor)) return plain;
  for (let i = 0; i < 18; i++) {
    const mid = (ok + bad) / 2;
    if (holds(fill(mid, c, h), theme, floor)) ok = mid;
    else bad = mid;
  }
  return fill(ok, c, h);
}

/** The row's four fills (`#rrggbb`) for a pick on this theme, and whether it is the approved target unchanged. */
export function tintRows(hex: string, theme: TintTheme): { fills: [string, string, string, string]; exact: boolean } {
  const { ls, c, h } = target(hex, theme);
  const floor = floors(theme);
  let exact = true;
  const fills = ls.map((L, i) => {
    const goal = fill(L, c, h);
    if (holds(goal, theme, floor[i]!)) return rgbHex(goal);
    exact = false;
    return rgbHex(stateFill(L, c, h, theme, floor[i]!, theme.plain[i]!));
  }) as [string, string, string, string];
  return { fills, exact };
}

/** The default theme (packages/ui/themes/plannotator.css), for a window that cannot read its theme yet. */
const ok = (L: number, C: number, H: number): Rgb => hexRgb(oklchToHex(L, C, H));
export const DEFAULT_TINT_THEMES: { light: TintTheme; dark: TintTheme } = {
  light: { card: ok(1, 0, 0), fg: ok(0.18, 0.02, 260), muted: ok(0.4, 0.02, 260), plain: plainFills(ok(1, 0, 0), ok(0.92, 0.01, 260), ok(0.5, 0.25, 280), true) },
  dark: { card: ok(0.22, 0.02, 260), fg: ok(0.9, 0.01, 260), muted: ok(0.72, 0.02, 260), plain: plainFills(ok(0.22, 0.02, 260), ok(0.26, 0.02, 260), ok(0.75, 0.18, 280), false) },
};
