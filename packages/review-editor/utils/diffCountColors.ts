import {
  compositeOver,
  contrastRatio,
  oklchToRgb,
  parseCssColor,
  quantize,
  relativeLuminance,
  rgbToOklch,
  toHex,
  type RgbColor,
} from '@plannotator/ui/utils/cssColor';

export const DIFF_COUNT_CONTRAST_MIN = 4.5;
const HEADROOM = 0.1;

export const DIFF_COUNT_TOKEN_NAMES = ['background', 'foreground', 'card', 'muted', 'primary', 'success', 'destructive'] as const;
export type DiffCountTokens = Partial<Record<(typeof DIFF_COUNT_TOKEN_NAMES)[number], string>>;

const WHITE: RgbColor = { r: 1, g: 1, b: 1, a: 1 };

export function diffCountSurfaces(tokens: DiffCountTokens): RgbColor[] | undefined {
  const background = parseCssColor(tokens.background);
  if (!background) return undefined;
  const page = compositeOver(background, WHITE);
  const card = parseCssColor(tokens.card);
  const aside = card ? compositeOver({ ...card, a: card.a * 0.3 }, page) : page;
  const surfaces = [aside];
  const primary = parseCssColor(tokens.primary);
  if (primary) surfaces.push(compositeOver({ ...primary, a: primary.a * 0.15 }, aside));
  const muted = parseCssColor(tokens.muted);
  if (muted) surfaces.push(compositeOver(muted, aside));
  return surfaces.map(quantize);
}

const worstContrast = (color: RgbColor, surfaces: readonly RgbColor[]) =>
  Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));

function inGamut(L: number, C: number, H: number): RgbColor {
  let lo = 0;
  let hi = C;
  const fits = (c: number) => {
    const rgb = oklchToRgb({ L, C: c, H });
    const back = rgbToOklch(rgb);
    return Math.abs(back.L - L) < 0.004 && Math.abs(back.C - c) < 0.004;
  };
  if (fits(C)) return { ...oklchToRgb({ L, C, H }), a: 1 };
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { ...oklchToRgb({ L, C: lo, H }), a: 1 };
}

export function readableByLightness(color: RgbColor, surfaces: readonly RgbColor[], min: number): RgbColor {
  const start = quantize(color);
  if (worstContrast(start, surfaces) >= min) return start;
  const { L, C, H } = rgbToOklch(start);
  const end = relativeLuminance(surfaces[0]) < 0.18 ? 1 : 0;
  const at = (l: number) => quantize(inGamut(l, C, H));
  if (worstContrast(at(end), surfaces) < min) return at(end);
  let lo = L;
  let hi = end;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (worstContrast(at(mid), surfaces) >= min) hi = mid;
    else lo = mid;
  }
  return at(hi);
}

const ACHROMATIC = 0.03;
const FALLBACK_SUCCESS: RgbColor = { r: 0x3f / 255, g: 0xb9 / 255, b: 0x50 / 255, a: 1 };
const FALLBACK_DESTRUCTIVE: RgbColor = { r: 0xe5 / 255, g: 0x48 / 255, b: 0x4d / 255, a: 1 };

function withHue(color: RgbColor | undefined, fallback: RgbColor): RgbColor | undefined {
  if (!color) return undefined;
  return rgbToOklch(color).C < ACHROMATIC ? fallback : color;
}

export function diffCountColors(tokens: DiffCountTokens | undefined): { additions: string; deletions: string } | undefined {
  if (!tokens) return undefined;
  const surfaces = diffCountSurfaces(tokens);
  const success = withHue(parseCssColor(tokens.success), FALLBACK_SUCCESS);
  const destructive = withHue(parseCssColor(tokens.destructive), FALLBACK_DESTRUCTIVE);
  if (!surfaces || !success || !destructive) return undefined;
  const min = DIFF_COUNT_CONTRAST_MIN + HEADROOM;
  return {
    additions: toHex(readableByLightness(compositeOver(success, surfaces[0]), surfaces, min)),
    deletions: toHex(readableByLightness(compositeOver(destructive, surfaces[0]), surfaces, min)),
  };
}
