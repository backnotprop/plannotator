/**
 * The Glass faces of the agent marks, drawn as vectors: one glass tile in many colours, each the same object (the
 * same top light, rim, depth and goggles), so a colour is the only thing that changes. Black and Yellow redraw the
 * tab icon's Glass and Yellow pictures (the dark glass with a cream frame and orange lenses; the light glass with an
 * ink frame and ink lenses, each with an orange pixel). Each colour is set in OKLCH and tuned on its own, so none
 * looks muddy or neon at 24 px, on light and dark sidebars alike.
 *
 * Markup from our own code only: each face is an `<img>` of an svg data URL (its gradient and filter ids stay inside
 * it, and an image keeps sharp while its layer moves).
 */
import type { GlassFace } from './faceChoices';
import { GOGGLES_FRAME, GOGGLES_LENSES, GOGGLES_MOUTH } from './goggles';

/** A colour in OKLCH: lightness 0..1, chroma, hue in degrees. */
export type Oklch = readonly [l: number, c: number, h: number];

export interface GlassColour {
  /** The stored face id (Black and Yellow keep the ids they had: `glass`, `yellow`). */
  id: GlassFace;
  /** The glass itself. */
  tint: Oklch;
  /** `dark`: a cream frame on the glass; `light`: an ink frame, as Yellow. */
  frame: 'dark' | 'light';
  /** The lenses: orange squares (Black), or ink ones with an orange pixel (Yellow). */
  lens: 'orange' | 'ink';
  /** The mouth, when the usual magenta would not read on this glass. */
  mouth?: Oklch;
}

/** The set, in the order the picker shows it (round the hue wheel, black first, ice last). */
export const GLASS_COLOURS: readonly GlassColour[] = [
  { id: 'glass', tint: [0.235, 0.006, 75], frame: 'dark', lens: 'orange' },
  { id: 'glass-red', tint: [0.53, 0.175, 25], frame: 'dark', lens: 'ink', mouth: [0.93, 0.035, 80] },
  { id: 'glass-orange', tint: [0.71, 0.165, 52], frame: 'light', lens: 'ink' },
  { id: 'yellow', tint: [0.865, 0.135, 93], frame: 'light', lens: 'ink' },
  { id: 'glass-green', tint: [0.6, 0.135, 152], frame: 'dark', lens: 'orange' },
  { id: 'glass-teal', tint: [0.6, 0.095, 196], frame: 'dark', lens: 'orange' },
  { id: 'glass-blue', tint: [0.53, 0.165, 258], frame: 'dark', lens: 'orange' },
  { id: 'glass-purple', tint: [0.5, 0.17, 302], frame: 'dark', lens: 'orange', mouth: [0.78, 0.15, 350] },
  { id: 'glass-pink', tint: [0.74, 0.135, 352], frame: 'light', lens: 'ink', mouth: [0.42, 0.16, 352] },
  { id: 'glass-ice', tint: [0.955, 0.018, 230], frame: 'light', lens: 'ink' },
];

/* ---------- OKLCH to sRGB hex (CSS Color 4's matrices), so the svg needs no newer colour syntax ---------- */
function toLinear([l, c, h]: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
}
const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** An OKLCH colour as #rrggbb; out of gamut, its chroma comes down until it fits (the hue and lightness kept). */
export function oklchHex(colour: Oklch): string {
  let [l, c, h] = colour;
  l = Math.max(0, Math.min(1, l));
  let rgb = toLinear([l, c, h]);
  for (let i = 0; i < 24 && rgb.some((v) => v < -0.0005 || v > 1.0005); i++) {
    c *= 0.94;
    rgb = toLinear([l, c, h]);
  }
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(1, gamma(Math.max(0, v)))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

const shift = ([l, c, h]: Oklch, dl: number, kc = 1): Oklch => [l + dl, c * kc, h];

/** The face as an svg, in the 1024 grid of the tab icon (the tile 72..952). */
export function glassSvg(colour: GlassColour): string {
  const t = colour.tint;
  const dark = colour.frame === 'dark';
  const hex = oklchHex;
  // The glass: lit from above, deeper below; the lighter the glass the less it needs to fall off.
  const top = hex(shift(t, t[0] > 0.8 ? 0.035 : 0.075, 0.85));
  const mid = hex(t);
  const low = hex(shift(t, t[0] > 0.8 ? -0.045 : -0.085, 1.04));
  // The frame: cream on a dark glass, ink on a light one.
  const frameTop = dark ? '#fbf4e6' : '#2a2724';
  const frameLow = dark ? '#e6d7bb' : '#0d0c0b';
  const edge = dark ? 'rgba(90,70,40,0.55)' : 'rgba(255,255,255,0.10)';
  const orange = ['#ff7a33', '#f0561c'];
  const mouth = colour.mouth ? hex(colour.mouth) : dark ? '#e3179a' : '#b0076f';
  const [lx, ly, lw, lh] = GOGGLES_LENSES[0]!;
  const [rx, ry, rw, rh] = GOGGLES_LENSES[1]!;
  const [mx, my, mw, mh] = GOGGLES_MOUTH;
  const lenses =
    colour.lens === 'orange'
      ? `<g filter="url(#g)" fill="url(#o)"><rect x="${lx}" y="${ly}" width="${lw}" height="${lh}"/><rect x="${rx}" y="${ry}" width="${rw}" height="${rh}"/></g>`
      : `<g fill="#0e0d0c"><rect x="${lx}" y="${ly}" width="${lw}" height="${lh}"/><rect x="${rx}" y="${ry}" width="${rw}" height="${rh}"/></g>` +
        `<g fill="${orange[0]}"><rect x="${lx + 21}" y="${ly + 19}" width="31" height="31"/><rect x="${rx + 20}" y="${ry + 19}" width="31" height="31"/></g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="72 72 880 880">` +
    `<defs>` +
    `<linearGradient id="t" x1="0" y1="72" x2="0" y2="952" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${top}"/><stop offset=".45" stop-color="${mid}"/><stop offset="1" stop-color="${low}"/></linearGradient>` +
    `<radialGradient id="h" cx="512" cy="40" r="560" gradientTransform="translate(0 40) scale(1 .62) translate(0 -40)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="${dark ? 0.2 : 0.42}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="r" x1="0" y1="72" x2="0" y2="952" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".22" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity=".04"/></linearGradient>` +
    `<linearGradient id="f" x1="0" y1="322" x2="0" y2="596" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${frameTop}"/><stop offset="1" stop-color="${frameLow}"/></linearGradient>` +
    `<linearGradient id="o" x1="0" y1="400" x2="0" y2="511" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${orange[0]}"/><stop offset="1" stop-color="${orange[1]}"/></linearGradient>` +
    `<filter id="s" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="12" stdDeviation="10" flood-color="#000" flood-opacity="${dark ? 0.45 : 0.3}"/></filter>` +
    `<filter id="g" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur in="SourceGraphic" stdDeviation="14" result="b"/><feComponentTransfer in="b" result="b2"><feFuncA type="linear" slope=".55"/></feComponentTransfer><feMerge><feMergeNode in="b2"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `</defs>` +
    `<rect x="72" y="72" width="880" height="880" fill="url(#t)"/>` +
    `<rect x="72" y="72" width="880" height="880" fill="url(#h)"/>` +
    `<rect x="78" y="78" width="868" height="868" fill="none" stroke="url(#r)" stroke-width="10"/>` +
    `<rect x="73.5" y="73.5" width="877" height="877" fill="none" stroke="#000" stroke-opacity="${t[0] > 0.8 ? 0.16 : 0.3}" stroke-width="3"/>` +
    `<g filter="url(#s)"><path transform="scale(.5)" fill-rule="evenodd" fill="url(#f)" stroke="${edge}" stroke-width="6" d="${GOGGLES_FRAME}"/></g>` +
    lenses +
    `<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" fill="${mouth}"${dark ? ' filter="url(#g)"' : ''}/>` +
    `</svg>`
  );
}

/** The face as a data URL (for an `<img>`). */
export const glassDataUrl = (colour: GlassColour): string => `data:image/svg+xml,${encodeURIComponent(glassSvg(colour))}`;
