/**
 * Small, dependency-free CSS colour toolkit for theme-derived rendering.
 *
 * Plannotator's palettes write their tokens as hex, `rgb()` and `oklch()`
 * (see `packages/ui/themes/*.css`), and a browser's computed value for a
 * colour can also come back as `oklab()`, `lab()`, `lch()`, `hsl()` or
 * `color(srgb ...)`. Mermaid's own colour library (khroma) understands only
 * the legacy syntaxes, so anything handed to it as a theme variable must first
 * be reduced to an opaque hex string. That reduction, plus the perceptual
 * mixing and the WCAG contrast arithmetic the diagram theme is built on, live
 * here so `mermaidTheme.ts` reads as a mapping rather than as colour math.
 *
 * Browser-free on purpose: every function is pure and runs under plain `bun
 * test`, which is what lets the contrast guard be unit-tested per palette.
 */

/** sRGB colour, channels 0..1, straight (non-premultiplied) alpha. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  navy: '#000080',
  grey: '#808080',
  gray: '#808080',
  lightgrey: '#d3d3d3',
  lightgray: '#d3d3d3',
  darkgrey: '#a9a9a9',
  darkgray: '#a9a9a9',
  silver: '#c0c0c0',
  orange: '#ffa500',
  purple: '#800080',
  teal: '#008080',
  transparent: '#00000000',
};

/**
 * Parse one CSS colour value into sRGB. Returns `undefined` for anything it
 * does not understand (a `var()` reference, `color-mix()`, an empty string),
 * which callers treat as "token absent".
 *
 * Supported: `#rgb[a]`, `#rrggbb[aa]`, `rgb()`/`rgba()` (comma or space
 * syntax, percentages, `/ alpha`), `hsl()`/`hsla()`, `oklch()`, `oklab()`,
 * `lab()`, `lch()`, `color(srgb|srgb-linear|display-p3 ...)`, and a handful of
 * named colours. Wide-gamut input is clipped to sRGB per channel.
 */
export function parseCssColor(input: string | null | undefined): RgbColor | undefined {
  if (typeof input !== 'string') return undefined;
  const value = input.trim().toLowerCase();
  if (!value) return undefined;

  if (value.startsWith('#')) return parseHex(value);
  if (value in NAMED_COLORS) return parseHex(NAMED_COLORS[value]);

  const fn = value.match(/^([a-z-]+)\((.*)\)$/s);
  if (!fn) return undefined;
  const name = fn[1];
  const body = fn[2].trim();

  switch (name) {
    case 'rgb':
    case 'rgba':
      return parseRgbFunction(body);
    case 'hsl':
    case 'hsla':
      return parseHslFunction(body);
    case 'oklch':
      return parseOklchFunction(body);
    case 'oklab':
      return parseOklabFunction(body);
    case 'lab':
      return parseLabFunction(body);
    case 'lch':
      return parseLchFunction(body);
    case 'color':
      return parseColorFunction(body);
    default:
      return undefined;
  }
}

function parseHex(value: string): RgbColor | undefined {
  const hex = value.slice(1);
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  let r: number;
  let g: number;
  let b: number;
  let a = 255;
  if (hex.length === 3 || hex.length === 4) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
    if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 6 || hex.length === 8) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
    if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16);
  } else {
    return undefined;
  }
  return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
}

/** Split a function body into channel tokens and an optional `/ alpha`. */
function splitChannels(body: string): { parts: string[]; alpha: string | undefined } | undefined {
  let main = body;
  let alpha: string | undefined;
  const slash = body.indexOf('/');
  if (slash >= 0) {
    main = body.slice(0, slash);
    alpha = body.slice(slash + 1).trim();
  }
  const parts = main
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (alpha === undefined && parts.length === 4) {
    // legacy `rgba(r, g, b, a)` / `hsla(h, s, l, a)`
    alpha = parts.pop();
  }
  if (parts.length !== 3) return undefined;
  return { parts, alpha };
}

function parseNumber(token: string, scale = 1): number | undefined {
  if (token === 'none') return 0;
  const m = token.match(/^(-?\d*\.?\d+(?:e[-+]?\d+)?)(%|deg|rad|grad|turn)?$/);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  switch (m[2]) {
    case '%':
      return (n / 100) * scale;
    case 'rad':
      return (n * 180) / Math.PI;
    case 'grad':
      return n * 0.9;
    case 'turn':
      return n * 360;
    default:
      return n;
  }
}

function parseAlpha(token: string | undefined): number | undefined {
  if (token === undefined) return 1;
  const a = parseNumber(token, 1);
  return a === undefined ? undefined : clamp01(a);
}

function parseRgbFunction(body: string): RgbColor | undefined {
  const split = splitChannels(body);
  if (!split) return undefined;
  const ch = split.parts.map((p) => (p.endsWith('%') ? parseNumber(p, 1) : (parseNumber(p) ?? NaN) / 255));
  const a = parseAlpha(split.alpha);
  if (ch.some((v) => v === undefined || Number.isNaN(v)) || a === undefined) return undefined;
  return { r: clamp01(ch[0] as number), g: clamp01(ch[1] as number), b: clamp01(ch[2] as number), a };
}

function parseHslFunction(body: string): RgbColor | undefined {
  const split = splitChannels(body);
  if (!split) return undefined;
  const h = parseNumber(split.parts[0]);
  const s = parseNumber(split.parts[1], 1);
  const l = parseNumber(split.parts[2], 1);
  const a = parseAlpha(split.alpha);
  if (h === undefined || s === undefined || l === undefined || a === undefined) return undefined;
  const { r, g, b } = hslToRgb(((h % 360) + 360) % 360, clamp01(s), clamp01(l));
  return { r, g, b, a };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return { r: rgb[0] + m, g: rgb[1] + m, b: rgb[2] + m };
}

function parseOklchFunction(body: string): RgbColor | undefined {
  const split = splitChannels(body);
  if (!split) return undefined;
  const L = parseNumber(split.parts[0], 1);
  const C = parseNumber(split.parts[1], 0.4);
  const H = parseNumber(split.parts[2]);
  const a = parseAlpha(split.alpha);
  if (L === undefined || C === undefined || H === undefined || a === undefined) return undefined;
  return { ...oklchToRgb({ L, C, H }), a };
}

function parseOklabFunction(body: string): RgbColor | undefined {
  const split = splitChannels(body);
  if (!split) return undefined;
  const L = parseNumber(split.parts[0], 1);
  const aa = parseNumber(split.parts[1], 0.4);
  const bb = parseNumber(split.parts[2], 0.4);
  const a = parseAlpha(split.alpha);
  if (L === undefined || aa === undefined || bb === undefined || a === undefined) return undefined;
  return { ...oklabToRgb({ L, a: aa, b: bb }), a };
}

function parseLabFunction(body: string): RgbColor | undefined {
  const split = splitChannels(body);
  if (!split) return undefined;
  const L = parseNumber(split.parts[0], 100);
  const aa = parseNumber(split.parts[1], 125);
  const bb = parseNumber(split.parts[2], 125);
  const a = parseAlpha(split.alpha);
  if (L === undefined || aa === undefined || bb === undefined || a === undefined) return undefined;
  return { ...xyzToRgb(labToXyz(L, aa, bb)), a };
}

function parseLchFunction(body: string): RgbColor | undefined {
  const split = splitChannels(body);
  if (!split) return undefined;
  const L = parseNumber(split.parts[0], 100);
  const C = parseNumber(split.parts[1], 150);
  const H = parseNumber(split.parts[2]);
  const a = parseAlpha(split.alpha);
  if (L === undefined || C === undefined || H === undefined || a === undefined) return undefined;
  const rad = (H * Math.PI) / 180;
  return { ...xyzToRgb(labToXyz(L, C * Math.cos(rad), C * Math.sin(rad))), a };
}

function parseColorFunction(body: string): RgbColor | undefined {
  const m = body.match(/^([a-z0-9-]+)\s+(.*)$/s);
  if (!m) return undefined;
  const space = m[1];
  const split = splitChannels(m[2]);
  if (!split) return undefined;
  const ch = split.parts.map((p) => parseNumber(p, 1));
  const a = parseAlpha(split.alpha);
  if (ch.some((v) => v === undefined) || a === undefined) return undefined;
  const [x, y, z] = ch as [number, number, number];
  switch (space) {
    case 'srgb':
      return { r: clamp01(x), g: clamp01(y), b: clamp01(z), a };
    case 'srgb-linear':
      return { r: clamp01(linearToSrgb(x)), g: clamp01(linearToSrgb(y)), b: clamp01(linearToSrgb(z)), a };
    case 'display-p3': {
      const lin = [srgbToLinear(x), srgbToLinear(y), srgbToLinear(z)];
      // display-p3 (linear) -> XYZ D65
      const X = 0.4865709 * lin[0] + 0.2656677 * lin[1] + 0.1982173 * lin[2];
      const Y = 0.2289746 * lin[0] + 0.6917385 * lin[1] + 0.0792869 * lin[2];
      const Z = 0.0 * lin[0] + 0.0451134 * lin[1] + 1.0439444 * lin[2];
      return { ...xyzToRgb({ X, Y, Z }), a };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Colour spaces
// ---------------------------------------------------------------------------

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

interface Xyz {
  X: number;
  Y: number;
  Z: number;
}

function xyzToRgb({ X, Y, Z }: Xyz): { r: number; g: number; b: number } {
  const rl = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const gl = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const bl = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return { r: clamp01(linearToSrgb(rl)), g: clamp01(linearToSrgb(gl)), b: clamp01(linearToSrgb(bl)) };
}

/** CIE Lab (D50 white as CSS specifies) -> XYZ D65 via Bradford. */
function labToXyz(L: number, a: number, b: number): Xyz {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const xr = Math.pow(fx, 3) > e ? Math.pow(fx, 3) : (116 * fx - 16) / k;
  const yr = L > k * e ? Math.pow((L + 16) / 116, 3) : L / k;
  const zr = Math.pow(fz, 3) > e ? Math.pow(fz, 3) : (116 * fz - 16) / k;
  // D50 reference white
  const X50 = xr * 0.3457 / 0.3585;
  const Y50 = yr;
  const Z50 = zr * (1 - 0.3457 - 0.3585) / 0.3585;
  // Bradford D50 -> D65
  return {
    X: 0.9554734 * X50 - 0.0230985 * Y50 + 0.0632593 * Z50,
    Y: -0.0283697 * X50 + 1.0099954 * Y50 + 0.0210413 * Z50,
    Z: 0.0123141 * X50 - 0.0205050 * Y50 + 1.3299098 * Z50,
  };
}

/** OKLab, the perceptual space every mix and lightness edit here is done in. */
export interface Oklab {
  L: number;
  a: number;
  b: number;
}

export interface Oklch {
  L: number;
  C: number;
  H: number;
}

export function rgbToOklab({ r, g, b }: { r: number; g: number; b: number }): Oklab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToRgb({ L, a, b }: Oklab): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return { r: clamp01(linearToSrgb(lr)), g: clamp01(linearToSrgb(lg)), b: clamp01(linearToSrgb(lb)) };
}

export function oklabToOklch({ L, a, b }: Oklab): Oklch {
  const C = Math.sqrt(a * a + b * b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

export function oklchToOklab({ L, C, H }: Oklch): Oklab {
  const rad = (H * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

export function oklchToRgb(c: Oklch): { r: number; g: number; b: number } {
  return oklabToRgb(oklchToOklab(c));
}

export function rgbToOklch(c: { r: number; g: number; b: number }): Oklch {
  return oklabToOklch(rgbToOklab(c));
}

// ---------------------------------------------------------------------------
// Compositing, mixing, contrast
// ---------------------------------------------------------------------------

/** Alpha-composite `top` over an opaque `under` (source-over). */
export function compositeOver(top: RgbColor, under: RgbColor): RgbColor {
  const a = clamp01(top.a);
  if (a >= 1) return { r: top.r, g: top.g, b: top.b, a: 1 };
  return {
    r: top.r * a + under.r * (1 - a),
    g: top.g * a + under.g * (1 - a),
    b: top.b * a + under.b * (1 - a),
    a: 1,
  };
}

/** Perceptual mix in OKLab: `t = 0` is `from`, `t = 1` is `to`. Alpha ignored. */
export function mixOklab(from: RgbColor, to: RgbColor, t: number): RgbColor {
  const k = clamp01(t);
  const a = rgbToOklab(from);
  const b = rgbToOklab(to);
  const rgb = oklabToRgb({ L: a.L + (b.L - a.L) * k, a: a.a + (b.a - a.a) * k, b: a.b + (b.b - a.b) * k });
  return { ...rgb, a: 1 };
}

/** WCAG relative luminance of an opaque sRGB colour. */
export function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio between two opaque colours (1..21). */
export function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/** Round to the 8-bit sRGB grid a hex string carries, so a contrast measured
 *  here equals the contrast of the colour Mermaid actually receives. */
export function quantize(color: RgbColor): RgbColor {
  const q = (v: number) => Math.round(clamp01(v) * 255) / 255;
  return { r: q(color.r), g: q(color.g), b: q(color.b), a: 1 };
}

/** `#rrggbb` (alpha dropped; callers composite first when it matters). */
export function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const h = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Parse, then composite any alpha over `backdrop` so the result is opaque. */
export function parseOpaqueColor(value: string | null | undefined, backdrop: RgbColor): RgbColor | undefined {
  const parsed = parseCssColor(value);
  if (!parsed) return undefined;
  return compositeOver(parsed, backdrop);
}

/** Return a copy of `color` with its OKLCH lightness set to `L` (0..1). */
export function withOklchLightness(color: RgbColor, L: number): RgbColor {
  const lch = rgbToOklch(color);
  return { ...oklchToRgb({ ...lch, L: clamp01(L) }), a: 1 };
}

/** Return a copy of `color` with its OKLCH chroma capped at `maxC`. */
export function withMaxChroma(color: RgbColor, maxC: number): RgbColor {
  const lch = rgbToOklch(color);
  if (lch.C <= maxC) return { ...color, a: 1 };
  return { ...oklchToRgb({ ...lch, C: maxC }), a: 1 };
}

/** Rotate hue by `deg` in OKLCH. */
export function rotateHue(color: RgbColor, deg: number): RgbColor {
  const lch = rgbToOklch(color);
  return { ...oklchToRgb({ ...lch, H: (((lch.H + deg) % 360) + 360) % 360 }), a: 1 };
}

/** Smallest angular distance between two hues (degrees, 0..180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}
