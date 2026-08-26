/**
 * Precision color parsing, conversions, alpha compositing, and WCAG 2.2 relative
 * luminance & contrast ratio calculation.
 */

export interface RGBA {
  r: number; // 0..1
  g: number; // 0..1
  b: number; // 0..1
  a: number; // 0..1
}

export interface OKLCH {
  l: number; // 0..1
  c: number; // 0..~0.4
  h: number; // 0..360
  a: number; // 0..1
}

export interface OKLab {
  L: number;
  a: number;
  b: number;
  alpha: number;
}

export interface CIELab {
  L: number;
  a: number;
  b: number;
  alpha: number;
}

export type ColorSpace = 'srgb' | 'oklch' | 'oklab' | 'lab';

export interface ColorResolutionContext {
  resolveVar: (name: string) => string | undefined;
}

const NAMED_COLORS: Record<string, RGBA> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 1, g: 1, b: 1, a: 1 },
  red: { r: 1, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 0.50196, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 1, a: 1 },
  yellow: { r: 1, g: 1, b: 0, a: 1 },
  cyan: { r: 0, g: 1, b: 1, a: 1 },
  magenta: { r: 1, g: 0, b: 1, a: 1 },
  gray: { r: 0.50196, g: 0.50196, b: 0.50196, a: 1 },
  grey: { r: 0.50196, g: 0.50196, b: 0.50196, a: 1 },
};

/** Convert 8-bit channel to 0..1 float */
function c255(v: number): number {
  return Math.max(0, Math.min(1, v / 255));
}

/** Parse an alpha component which may be a float 0..1 or percentage 0..100% */
function parseAlpha(val: string): number {
  const trimmed = val.trim();
  if (trimmed.endsWith('%')) {
    return Math.max(0, Math.min(1, parseFloat(trimmed.slice(0, -1)) / 100));
  }
  return Math.max(0, Math.min(1, parseFloat(trimmed)));
}

/** Parse a channel that may be a 0..255 number or 0..100% */
function parseRgbChannel(val: string): number {
  const trimmed = val.trim();
  if (trimmed.endsWith('%')) {
    return Math.max(0, Math.min(1, parseFloat(trimmed.slice(0, -1)) / 100));
  }
  return c255(parseFloat(trimmed));
}

/** Parse hex color string */
export function parseHex(hex: string): RGBA | null {
  let clean = hex.trim();
  if (!clean.startsWith('#')) return null;
  clean = clean.slice(1);
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(clean)) return null;

  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return { r: c255(r), g: c255(g), b: c255(b), a: 1 };
  }
  if (clean.length === 4) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    const a = parseInt(clean[3] + clean[3], 16);
    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) return null;
    return { r: c255(r), g: c255(g), b: c255(b), a: c255(a) };
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return { r: c255(r), g: c255(g), b: c255(b), a: 1 };
  }
  if (clean.length === 8) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    const a = parseInt(clean.slice(6, 8), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) return null;
    return { r: c255(r), g: c255(g), b: c255(b), a: c255(a) };
  }
  return null;
}

/** HSL to RGB conversion */
export function hslToRgb(h: number, s: number, l: number, a = 1): RGBA {
  const normH = ((h % 360) + 360) % 360;
  const normS = Math.max(0, Math.min(1, s > 1 ? s / 100 : s));
  const normL = Math.max(0, Math.min(1, l > 1 ? l / 100 : l));

  const c = (1 - Math.abs(2 * normL - 1)) * normS;
  const x = c * (1 - Math.abs(((normH / 60) % 2) - 1));
  const m = normL - c / 2;

  let r1 = 0, g1 = 0, b1 = 0;
  if (normH < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (normH < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (normH < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (normH < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (normH < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }

  return {
    r: Math.max(0, Math.min(1, r1 + m)),
    g: Math.max(0, Math.min(1, g1 + m)),
    b: Math.max(0, Math.min(1, b1 + m)),
    a: Math.max(0, Math.min(1, a)),
  };
}

/** OKLab to Linear sRGB */
export function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLin = +4.0767434036 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return [rLin, gLin, bLin];
}

/** Linear sRGB to standard sRGB channel */
export function linearSrgbToSrgb(cLin: number): number {
  const clamped = Math.max(0, Math.min(1, cLin));
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/** Standard sRGB channel to linear sRGB channel */
export function srgbToLinearSrgb(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.04045
    ? clamped / 12.92
    : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

/** OKLCH to sRGB RGBA */
export function oklchToRgba(oklch: OKLCH): RGBA {
  const hRad = ((oklch.h % 360 + 360) % 360 * Math.PI) / 180;
  const a = oklch.c * Math.cos(hRad);
  const b = oklch.c * Math.sin(hRad);

  const [rLin, gLin, bLin] = oklabToLinearSrgb(oklch.l, a, b);

  return {
    r: Math.max(0, Math.min(1, linearSrgbToSrgb(rLin))),
    g: Math.max(0, Math.min(1, linearSrgbToSrgb(gLin))),
    b: Math.max(0, Math.min(1, linearSrgbToSrgb(bLin))),
    a: Math.max(0, Math.min(1, oklch.a)),
  };
}

/** OKLab to sRGB RGBA */
export function oklabToRgba(oklab: OKLab): RGBA {
  const [rLin, gLin, bLin] = oklabToLinearSrgb(oklab.L, oklab.a, oklab.b);
  return {
    r: Math.max(0, Math.min(1, linearSrgbToSrgb(rLin))),
    g: Math.max(0, Math.min(1, linearSrgbToSrgb(gLin))),
    b: Math.max(0, Math.min(1, linearSrgbToSrgb(bLin))),
    a: Math.max(0, Math.min(1, oklab.alpha)),
  };
}

/** sRGB RGBA to OKLab */
export function rgbaToOklab(rgba: RGBA): OKLab {
  const rLin = srgbToLinearSrgb(rgba.r);
  const gLin = srgbToLinearSrgb(rgba.g);
  const bLin = srgbToLinearSrgb(rgba.b);

  const l_ = Math.cbrt(0.4122214708 * rLin + 0.5363325363 * gLin + 0.0514459929 * bLin);
  const m_ = Math.cbrt(0.2119034982 * rLin + 0.6806995451 * gLin + 0.1073969566 * bLin);
  const s_ = Math.cbrt(0.0883024619 * rLin + 0.2817188376 * gLin + 0.6299787005 * bLin);

  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  return { L, a, b, alpha: rgba.a };
}

/** sRGB RGBA to OKLCH */
export function rgbaToOklch(rgba: RGBA): OKLCH {
  const { L, a, b, alpha } = rgbaToOklab(rgba);
  const c = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h, a: alpha };
}

/**
 * Composites foreground color over background color using standard sRGB alpha compositing.
 * Returns the resulting solid color (or composite with alpha if bg has alpha).
 */
export function compositeColors(fg: RGBA, bg: RGBA): RGBA {
  if (fg.a >= 1) return { ...fg, a: 1 };
  if (fg.a <= 0) return { ...bg };

  const outA = fg.a + bg.a * (1 - fg.a);
  if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };

  const r = (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / outA;
  const g = (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / outA;
  const b = (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / outA;

  return {
    r: Math.max(0, Math.min(1, r)),
    g: Math.max(0, Math.min(1, g)),
    b: Math.max(0, Math.min(1, b)),
    a: Math.max(0, Math.min(1, outA)),
  };
}

/**
 * Mix two colors according to CSS `color-mix(in <colorspace>, <color1> [p1]%, <color2> [p2]%)`
 */
/** Convert sRGB to CSS CIELAB (D50 white point). */
export function rgbaToLab(rgba: RGBA): CIELab {
  const r = srgbToLinearSrgb(rgba.r);
  const g = srgbToLinearSrgb(rgba.g);
  const b = srgbToLinearSrgb(rgba.b);
  const x65 = 0.4123907993 * r + 0.3575843394 * g + 0.1804807884 * b;
  const y65 = 0.2126390059 * r + 0.7151686788 * g + 0.0721923154 * b;
  const z65 = 0.0193308187 * r + 0.1191947798 * g + 0.9505321522 * b;
  const x = 1.0479298 * x65 + 0.0229468 * y65 - 0.0501922 * z65;
  const y = 0.0296278 * x65 + 0.9904345 * y65 - 0.0170738 * z65;
  const z = -0.009243 * x65 + 0.0150552 * y65 + 0.7518743 * z65;
  const delta = 6 / 29;
  const f = (value: number): number =>
    value > delta ** 3 ? Math.cbrt(value) : value / (3 * delta ** 2) + 4 / 29;
  const fx = f(x / 0.96422);
  const fy = f(y);
  const fz = f(z / 0.82521);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
    alpha: rgba.a,
  };
}

/** Convert CSS CIELAB (D50 white point) to sRGB. */
export function labToRgba(lab: CIELab): RGBA {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const delta = 6 / 29;
  const inverse = (value: number): number =>
    value > delta ? value ** 3 : 3 * delta ** 2 * (value - 4 / 29);
  const x50 = 0.96422 * inverse(fx);
  const y50 = inverse(fy);
  const z50 = 0.82521 * inverse(fz);
  const x = 0.9554734 * x50 - 0.0230985 * y50 + 0.0632593 * z50;
  const y = -0.0283697 * x50 + 1.0099955 * y50 + 0.0210414 * z50;
  const z = 0.012314 * x50 - 0.0205077 * y50 + 1.3303659 * z50;
  const r = 3.2409699419 * x - 1.5373831776 * y - 0.4986107603 * z;
  const g = -0.9692436363 * x + 1.8759675015 * y + 0.0415550574 * z;
  const b = 0.0556300797 * x - 0.2039769589 * y + 1.0569715142 * z;
  return {
    r: linearSrgbToSrgb(r),
    g: linearSrgbToSrgb(g),
    b: linearSrgbToSrgb(b),
    a: Math.max(0, Math.min(1, lab.alpha)),
  };
}

export function mixColors(
  space: ColorSpace,
  c1: RGBA,
  p1: number,
  c2: RGBA,
  p2: number
): RGBA {
  const total = p1 + p2;
  const weight1 = total > 0 ? p1 / total : 0.5;
  const weight2 = total > 0 ? p2 / total : 0.5;
  const alphaMultiplier = total < 100 ? total / 100 : 1;
  const mixedAlpha = c1.a * weight1 + c2.a * weight2;
  const alpha = mixedAlpha * alphaMultiplier;
  const colorWeight1 = mixedAlpha > 0 ? (c1.a * weight1) / mixedAlpha : weight1;
  const colorWeight2 = mixedAlpha > 0 ? (c2.a * weight2) / mixedAlpha : weight2;

  if (space === 'srgb') {
    return {
      r: Math.max(0, Math.min(1, c1.r * colorWeight1 + c2.r * colorWeight2)),
      g: Math.max(0, Math.min(1, c1.g * colorWeight1 + c2.g * colorWeight2)),
      b: Math.max(0, Math.min(1, c1.b * colorWeight1 + c2.b * colorWeight2)),
      a: Math.max(0, Math.min(1, alpha)),
    };
  }

  if (space === 'oklab') {
    const lab1 = rgbaToOklab(c1);
    const lab2 = rgbaToOklab(c2);
    return oklabToRgba({
      L: lab1.L * colorWeight1 + lab2.L * colorWeight2,
      a: lab1.a * colorWeight1 + lab2.a * colorWeight2,
      b: lab1.b * colorWeight1 + lab2.b * colorWeight2,
      alpha,
    });
  }

  if (space === 'lab') {
    const lab1 = rgbaToLab(c1);
    const lab2 = rgbaToLab(c2);
    return labToRgba({
      L: lab1.L * colorWeight1 + lab2.L * colorWeight2,
      a: lab1.a * colorWeight1 + lab2.a * colorWeight2,
      b: lab1.b * colorWeight1 + lab2.b * colorWeight2,
      alpha,
    });
  }

  const lch1 = rgbaToOklch(c1);
  const lch2 = rgbaToOklch(c2);
  let hue1 = lch1.h;
  let hue2 = lch2.h;
  const delta = hue2 - hue1;
  if (delta > 180) hue2 -= 360;
  else if (delta < -180) hue2 += 360;
  const mixedHue = ((hue1 * colorWeight1 + hue2 * colorWeight2) % 360 + 360) % 360;
  return oklchToRgba({
    l: lch1.l * colorWeight1 + lch2.l * colorWeight2,
    c: lch1.c * colorWeight1 + lch2.c * colorWeight2,
    h: mixedHue,
    a: alpha,
  });
}

/** WCAG 2.2 Relative Luminance for sRGB */
export function getRelativeLuminance(rgba: RGBA): number {
  const R = srgbToLinearSrgb(rgba.r);
  const G = srgbToLinearSrgb(rgba.g);
  const B = srgbToLinearSrgb(rgba.b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** WCAG 2.2 Contrast Ratio between two relative luminances */
export function getContrastRatioFromLuminance(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2.2 Contrast Ratio between two RGBA colors */
export function getContrastRatio(fg: RGBA, bg: RGBA): number {
  // If fg has alpha, composite it over bg first (assuming bg is the solid backdrop)
  const effectiveFg = fg.a < 1 ? compositeColors(fg, bg) : fg;
  const l1 = getRelativeLuminance(effectiveFg);
  const l2 = getRelativeLuminance(bg);
  return getContrastRatioFromLuminance(l1, l2);
}

/**
 * Parses any CSS color expression supported in the repository.
 * Handles hex, rgb, hsl, oklch, oklab, color-mix, var(), relative color syntax, etc.
 */
export function parseCssColor(
  rawInput: string,
  ctx?: ColorResolutionContext,
  depth = 0
): RGBA | null {
  if (depth > 20) {
    throw new Error(`Exceeded max var() resolution depth while parsing: ${rawInput}`);
  }

  let input = rawInput.trim();
  if (!input) return null;

  // Named color
  const lower = input.toLowerCase();
  if (NAMED_COLORS[lower]) {
    return NAMED_COLORS[lower];
  }

  // Hex color
  if (input.startsWith('#')) {
    return parseHex(input);
  }

  // var(--name, fallback)
  if (input.startsWith('var(')) {
    const inner = input.slice(4, input.lastIndexOf(')')).trim();
    let varName = inner;
    let fallback: string | undefined;

    const commaIdx = findTopLevelComma(inner);
    if (commaIdx !== -1) {
      varName = inner.slice(0, commaIdx).trim();
      fallback = inner.slice(commaIdx + 1).trim();
    }

    const resolved = ctx?.resolveVar(varName);
    if (resolved !== undefined && resolved.trim() !== '') {
      return parseCssColor(resolved, ctx, depth + 1);
    }
    if (fallback !== undefined) {
      return parseCssColor(fallback, ctx, depth + 1);
    }
    return null;
  }

  // color-mix(in <colorspace>, <color1> [p1]%, <color2> [p2]%)
  if (lower.startsWith('color-mix(')) {
    return parseColorMix(input, ctx, depth);
  }

  // oklch(from var(--foo) l c h / alpha) relative color syntax
  if (lower.startsWith('oklch(from ')) {
    return parseRelativeOklch(input, ctx, depth);
  }

  // oklch(L C H [/ A])
  if (lower.startsWith('oklch(')) {
    return parseOklch(input, ctx, depth);
  }

  // oklab(L a b [/ A])
  if (lower.startsWith('oklab(')) {
    return parseOklab(input, ctx, depth);
  }

  // rgb(...) / rgba(...)
  if (lower.startsWith('rgb(') || lower.startsWith('rgba(')) {
    return parseRgbFunction(input, ctx, depth);
  }

  // hsl(...) / hsla(...)
  if (lower.startsWith('hsl(') || lower.startsWith('hsla(')) {
    return parseHslFunction(input, ctx, depth);
  }

  return null;
}

function findTopLevelComma(str: string): number {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

function parseColorMix(
  input: string,
  ctx?: ColorResolutionContext,
  depth = 0
): RGBA | null {
  const content = input.slice(input.indexOf('(') + 1, input.lastIndexOf(')')).trim();
  const commaIdx = findTopLevelComma(content);
  if (commaIdx === -1) return null;

  const header = content.slice(0, commaIdx).trim(); // e.g. "in oklch" or "in srgb" or "in oklab"
  const rest = content.slice(commaIdx + 1).trim();

  let space: ColorSpace = 'srgb';
  const normalizedHeader = header.toLowerCase();
  if (normalizedHeader.includes('oklch')) space = 'oklch';
  else if (normalizedHeader.includes('oklab')) space = 'oklab';
  else if (/\blab\b/.test(normalizedHeader)) space = 'lab';
  else if (!normalizedHeader.includes('srgb')) return null;

  const secondComma = findTopLevelComma(rest);
  if (secondComma === -1) return null;

  const part1 = rest.slice(0, secondComma).trim();
  const part2 = rest.slice(secondComma + 1).trim();

  const [colorStr1, pct1] = extractColorAndPercentage(part1);
  const [colorStr2, pct2] = extractColorAndPercentage(part2);

  const c1 = parseCssColor(colorStr1, ctx, depth + 1);
  const c2 = parseCssColor(colorStr2, ctx, depth + 1);
  if (!c1 || !c2) return null;

  let p1 = pct1;
  let p2 = pct2;
  if (p1 === undefined && p2 === undefined) {
    p1 = 50;
    p2 = 50;
  } else if (p1 !== undefined && p2 === undefined) {
    p2 = 100 - p1;
  } else if (p1 === undefined && p2 !== undefined) {
    p1 = 100 - p2;
  }

  return mixColors(space, c1, p1 ?? 50, c2, p2 ?? 50);
}

function extractColorAndPercentage(part: string): [string, number | undefined] {
  const trimmed = part.trim();
  const pctMatch = trimmed.match(/\s+([0-9.]+)%\s*$/);
  if (pctMatch && pctMatch.index !== undefined) {
    const colorPart = trimmed.slice(0, pctMatch.index).trim();
    const pct = parseFloat(pctMatch[1]);
    return [colorPart, pct];
  }
  return [trimmed, undefined];
}

function parseRelativeOklch(
  input: string,
  ctx?: ColorResolutionContext,
  depth = 0
): RGBA | null {
  // oklch(from <origin-color> l c h [/ <alpha>])
  const content = input.slice(input.indexOf('from ') + 5, input.lastIndexOf(')')).trim();
  // Find where origin color ends: it can be var(--foo) or a color function or hex
  let originColorStr = '';
  let rest = '';

  if (content.startsWith('var(')) {
    const closeIdx = findMatchingParen(content, 3);
    originColorStr = content.slice(0, closeIdx + 1);
    rest = content.slice(closeIdx + 1).trim();
  } else {
    const firstSpace = content.indexOf(' ');
    if (firstSpace === -1) return null;
    originColorStr = content.slice(0, firstSpace);
    rest = content.slice(firstSpace + 1).trim();
  }

  const originColor = parseCssColor(originColorStr, ctx, depth + 1);
  if (!originColor) return null;

  const originOklch = rgbaToOklch(originColor);

  // rest is like "l c h / 0.35" or "l c h" or "0.8 c h / 0.5"
  const slashParts = rest.split('/');
  const channels = slashParts[0].trim().split(/\s+/);
  const alphaPart = slashParts[1]?.trim();

  let l = originOklch.l;
  let c = originOklch.c;
  let h = originOklch.h;
  let a = originOklch.a;

  if (channels[0] && channels[0] !== 'l') l = parseFloat(channels[0]);
  if (channels[1] && channels[1] !== 'c') c = parseFloat(channels[1]);
  if (channels[2] && channels[2] !== 'h') h = parseFloat(channels[2]);
  if (alphaPart) a = parseAlpha(alphaPart);

  return oklchToRgba({ l, c, h, a });
}

function findMatchingParen(str: string, openParenIdx: number): number {
  let depth = 0;
  for (let i = openParenIdx; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return str.length - 1;
}

function parseOklch(input: string, _ctx?: ColorResolutionContext, _depth = 0): RGBA | null {
  const content = input.slice(input.indexOf('(') + 1, input.lastIndexOf(')')).trim();
  const slashParts = content.split('/');
  const channels = slashParts[0].trim().split(/\s+/);
  if (channels.length < 3) return null;

  const l = parseFloat(channels[0]);
  const c = parseFloat(channels[1]);
  const h = parseFloat(channels[2]);
  let a = 1;

  if (slashParts[1]) {
    a = parseAlpha(slashParts[1]);
  }

  if (isNaN(l) || isNaN(c) || isNaN(h)) return null;
  return oklchToRgba({ l, c, h, a });
}

function parseOklab(input: string, _ctx?: ColorResolutionContext, _depth = 0): RGBA | null {
  const content = input.slice(input.indexOf('(') + 1, input.lastIndexOf(')')).trim();
  const slashParts = content.split('/');
  const channels = slashParts[0].trim().split(/\s+/);
  if (channels.length < 3) return null;

  const L = parseFloat(channels[0]);
  const a = parseFloat(channels[1]);
  const b = parseFloat(channels[2]);
  let alpha = 1;

  if (slashParts[1]) {
    alpha = parseAlpha(slashParts[1]);
  }

  if (isNaN(L) || isNaN(a) || isNaN(b)) return null;
  return oklabToRgba({ L, a, b, alpha });
}

function parseRgbFunction(input: string, _ctx?: ColorResolutionContext, _depth = 0): RGBA | null {
  const content = input.slice(input.indexOf('(') + 1, input.lastIndexOf(')')).trim();
  if (content.includes(',')) {
    const parts = content.split(',').map((p) => p.trim());
    if (parts.length < 3) return null;
    const r = parseRgbChannel(parts[0]);
    const g = parseRgbChannel(parts[1]);
    const b = parseRgbChannel(parts[2]);
    const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
    return { r, g, b, a };
  }

  const slashParts = content.split('/');
  const channels = slashParts[0].trim().split(/\s+/);
  if (channels.length < 3) return null;
  const r = parseRgbChannel(channels[0]);
  const g = parseRgbChannel(channels[1]);
  const b = parseRgbChannel(channels[2]);
  const a = slashParts[1] ? parseAlpha(slashParts[1]) : 1;
  return { r, g, b, a };
}

function parseHslFunction(input: string, _ctx?: ColorResolutionContext, _depth = 0): RGBA | null {
  const content = input.slice(input.indexOf('(') + 1, input.lastIndexOf(')')).trim();
  if (content.includes(',')) {
    const parts = content.split(',').map((p) => p.trim());
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]);
    const l = parseFloat(parts[2]);
    const a = parts[3] !== undefined ? parseAlpha(parts[3]) : 1;
    return hslToRgb(h, s, l, a);
  }

  const slashParts = content.split('/');
  const channels = slashParts[0].trim().split(/\s+/);
  if (channels.length < 3) return null;
  const h = parseFloat(channels[0]);
  const s = parseFloat(channels[1]);
  const l = parseFloat(channels[2]);
  const a = slashParts[1] ? parseAlpha(slashParts[1]) : 1;
  return hslToRgb(h, s, l, a);
}

/** Formats RGBA as standard hex string (`#rrggbb` or `#rrggbbaa`) */
export function formatHex(rgba: RGBA): string {
  const r = Math.round(rgba.r * 255).toString(16).padStart(2, '0');
  const g = Math.round(rgba.g * 255).toString(16).padStart(2, '0');
  const b = Math.round(rgba.b * 255).toString(16).padStart(2, '0');
  if (rgba.a < 1) {
    const a = Math.round(rgba.a * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}${a}`;
  }
  return `#${r}${g}${b}`;
}

/** Formats OKLCH as standard CSS string */
export function formatOklch(oklch: OKLCH): string {
  const l = oklch.l.toFixed(4).replace(/\.?0+$/, '');
  const c = oklch.c.toFixed(4).replace(/\.?0+$/, '');
  const h = oklch.h.toFixed(2).replace(/\.?0+$/, '');
  if (oklch.a < 1) {
    const a = oklch.a.toFixed(3).replace(/\.?0+$/, '');
    return `oklch(${l} ${c} ${h} / ${a})`;
  }
  return `oklch(${l} ${c} ${h})`;
}

/**
 * Deterministic suggestion solver: finds the minimal adjustment in OKLCH lightness (L)
 * (or slight chroma reduction if needed) to meet the required contrast ratio against a background.
 */
export function suggestCompliantOklch(
  fg: RGBA,
  bg: RGBA,
  targetRatio: number,
  mode: 'dark' | 'light'
): { oklch: OKLCH; hex: string; ratio: number } {
  const fgOklch = rgbaToOklch(fg);
  const bgLum = getRelativeLuminance(bg);

  // Determine whether to shift lighter or darker based on background luminance and mode
  // If bgLum < 0.2 (dark background), move lighter
  // If bgLum >= 0.2 (light background), move darker
  const shouldLighten = bgLum < 0.2 || (mode === 'dark' && bgLum < 0.5);

  let bestL = fgOklch.l;
  let bestRatio = getContrastRatio(fg, bg);

  if (bestRatio >= targetRatio) {
    return {
      oklch: fgOklch,
      hex: formatHex(fg),
      ratio: bestRatio,
    };
  }

  // Binary search for lightness
  let low = shouldLighten ? fgOklch.l : 0;
  let high = shouldLighten ? 1 : fgOklch.l;

  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    const testOklch: OKLCH = { ...fgOklch, l: mid };
    const testRgba = oklchToRgba(testOklch);
    const testRatio = getContrastRatio(testRgba, bg);

    if (testRatio >= targetRatio) {
      bestL = mid;
      bestRatio = testRatio;
      if (shouldLighten) {
        high = mid; // try to find smaller L
      } else {
        low = mid; // try to find larger L (closer to original)
      }
    } else {
      if (shouldLighten) {
        low = mid;
      } else {
        high = mid;
      }
    }
  }

  const resultLch: OKLCH = { ...fgOklch, l: bestL };
  const resultRgba = oklchToRgba(resultLch);

  return {
    oklch: resultLch,
    hex: formatHex(resultRgba),
    ratio: getContrastRatio(resultRgba, bg),
  };
}
