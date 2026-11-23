/**
 * Theme-aware Pele variables: the palette mapping for the Pele engine.
 *
 * Pele paints every colour through CSS custom properties resolved at paint
 * time (`--pele-bg`, `--pele-fg`, `--pele-surface`, ...). This module does not
 * derive a second palette: it takes the colours `buildMermaidThemeVariables`
 * already guards for Mermaid (canvas, text, line, node and cluster fills,
 * borders, the categorical scale) and hands the same colours to Pele, so a
 * diagram looks like the same palette whichever engine draws it.
 *
 * Two pairs Pele draws that Mermaid does not are re-guarded here:
 *   - Pele inks a label on a coloured fill (an accent shape, a critical
 *     gantt bar, a pie slice, a git branch, a mindmap section) with
 *     `--pele-bg`, the canvas colour. Mermaid inks those with the page
 *     background, so the series, accent and critical fills are pushed in
 *     lightness until the canvas colour reads on them at the text minimum.
 *   - Pele paints secondary text (ER attribute types, axis labels, cluster
 *     titles) in `--pele-muted`. It is the palette's `muted-foreground`,
 *     moved toward `foreground` only as far as it must to read on the
 *     canvas, the node fill and the cluster fill.
 * The thresholds are the Mermaid guard's: text 4.5:1 and lines 3:1 (each
 * plus the same 0.1 headroom), borders 1.5:1. `peleTheme.test.ts` checks every
 * pair over every palette in both modes.
 *
 * Pure below `readPeleThemeVariables`, which reads the live tokens.
 */
import {
  buildMermaidShadow,
  buildMermaidThemeVariables,
  clampShadowAmount,
  ensureContrast,
  isDarkBackground,
  MERMAID_BORDER_CONTRAST_MIN,
  MERMAID_LINE_CONTRAST_MIN,
  MERMAID_TEXT_CONTRAST_MIN,
  readThemeTokens,
  type MermaidThemeMode,
  type MermaidThemeTokens,
} from './mermaidTheme';
import {
  contrastRatio,
  parseCssColor,
  parseOpaqueColor,
  quantize,
  rgbToOklch,
  toHex,
  withOklchLightness,
  type RgbColor,
} from './cssColor';

/** The guard's minimums plus its headroom (see mermaidTheme.ts). */
export const PELE_TEXT_MIN = MERMAID_TEXT_CONTRAST_MIN + 0.1;
export const PELE_LINE_MIN = MERMAID_LINE_CONTRAST_MIN + 0.1;
export const PELE_BORDER_MIN = MERMAID_BORDER_CONTRAST_MIN;

/** Pele has eight series slots (`--pele-series-1` .. `-8`). */
export const PELE_SERIES_COUNT = 8;

export type PeleThemeVariables = Readonly<Record<`--pele-${string}`, string>>;

const WHITE: RgbColor = { r: 1, g: 1, b: 1, a: 1 };

/** Move a fill's lightness away from `ink` until `ink` reads on it. */
function fitFillForInk(fill: RgbColor, ink: RgbColor): RgbColor {
  let current = quantize(fill);
  const step = isDarkBackground(ink) ? 0.02 : -0.02;
  for (let i = 0; i < 48 && contrastRatio(ink, current) < PELE_TEXT_MIN; i++) {
    const L = rgbToOklch(current).L + step;
    if (L < 0.02 || L > 0.995) break;
    current = quantize(withOklchLightness(current, L));
  }
  return current;
}

/**
 * Pele's variables for a palette and mode, from the same tokens the Mermaid
 * mapping reads. Null when the tokens are missing (a host without the theme
 * tokens): Pele then keeps its own built-in colours.
 */
export function buildPeleThemeVariables(
  tokens: MermaidThemeTokens | undefined,
  mode: MermaidThemeMode,
): PeleThemeVariables | null {
  const spec = buildMermaidThemeVariables(tokens, mode);
  if (spec === null || tokens === undefined) return null;
  const v = spec.themeVariables as Record<string, string>;
  const color = (name: string): RgbColor => parseCssColor(v[name]) as RgbColor;
  const canvas = color('background');
  const fg = color('textColor');
  const surface = color('mainBkg');
  const surfaceAlt = color('secondBkg');
  const page = parseOpaqueColor(tokens.background, WHITE) ?? canvas;
  const inks = [fg, page];
  const muted = [canvas, surface, surfaceAlt].reduce(
    (current, fill) => ensureContrast(current, fill, PELE_TEXT_MIN, inks),
    quantize(parseOpaqueColor(tokens['muted-foreground'], page) ?? fg),
  );
  const series = Array.from({ length: PELE_SERIES_COUNT }, (_, i) => toHex(fitFillForInk(color(`cScale${i}`), canvas)));
  const font = spec.themeVariables.fontFamily;
  return {
    '--pele-bg': toHex(canvas),
    '--pele-fg': toHex(fg),
    '--pele-muted': toHex(muted),
    '--pele-line': v.lineColor as string,
    '--pele-surface': toHex(surface),
    '--pele-surface-alt': toHex(surfaceAlt),
    '--pele-border': v.nodeBorder as string,
    '--pele-accent': series[0] as string,
    '--pele-critical': toHex(fitFillForInk(color('critBkgColor'), canvas)),
    ...Object.fromEntries(series.map((hex, i) => [`--pele-series-${i + 1}`, hex])),
    ...(typeof font === 'string' && font !== '' ? { '--pele-font': font } : {}),
  };
}

/** Pele's variables for the live page (the document's theme tokens). */
export function readPeleThemeVariables(mode: MermaidThemeMode, root?: Element | null): PeleThemeVariables | null {
  return buildPeleThemeVariables(readThemeTokens(root), mode);
}

/** Set the variables on the element that wraps a Pele drawing (its svg root). */
export function applyPeleThemeVariables(el: SVGElement | HTMLElement, vars: PeleThemeVariables | null): void {
  if (vars === null) return;
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
}

/** A shadow value as `buildMermaidShadow` writes it: numbers and one colour, nothing else. */
const SHADOW_VALUE = /^drop-shadow\((?:-?[\d.]+px ){3}rgba?\([\d.,\s]+\)\)$/u;

/**
 * The Diagram Shadow setting under Pele: ONE rule, scoped under the svg's own
 * id, that puts on Pele's nodes, clusters and notes the `drop-shadow` Mermaid's
 * neo look puts on its nodes, clusters, actors and notes, with the same value
 * (`buildMermaidThemeVariables`' `dropShadow`: the palette's ground, the
 * page's polarity, the setting's amount). None when the setting is off, and
 * none on a mindmap or a gantt chart, which Mermaid draws without one.
 */
export function peleShadowCss(
  svg: Element,
  mode: MermaidThemeMode,
  shadowAmount: number | undefined,
  tokens: MermaidThemeTokens | undefined = readThemeTokens(),
): string | null {
  const id = svg.getAttribute('id') ?? '';
  if (!/^[\w-]+$/u.test(id) || /\bpele-(?:mindmap|gantt)\b/u.test(svg.getAttribute('class') ?? '')) return null;
  const amount = clampShadowAmount(shadowAmount);
  const spec = buildMermaidThemeVariables(tokens, mode, { shadowAmount: amount });
  const shadow = spec === null ? buildMermaidShadow(undefined, amount) : spec.themeVariables.dropShadow;
  if (typeof shadow !== 'string' || !SHADOW_VALUE.test(shadow)) return null;
  return `#${id} g.pele-node > :first-child, #${id} g.pele-cluster > rect:first-child, #${id} g.pele-note > :first-child { filter: ${shadow}; }`;
}
