/**
 * Theme-aware Mermaid configuration.
 *
 * Mermaid diagrams used to render from one static config (`MERMAID_CONFIG` in
 * `./mermaid`: the `dark` base theme plus a slate palette) in every one of
 * Plannotator's palettes and both modes. This module derives the diagram
 * theme from the live CSS tokens instead, the same tokens `ThemeProvider`
 * applies through `theme.css`, so a diagram follows the palette the way a
 * code fence already does (see `syntaxTheme.ts` / `useFenceTheme`).
 *
 * Three layers, each pure below the top one:
 *
 * 1. `readThemeTokens(el)` reads the handful of custom properties the mapping
 *    needs off the document (`getComputedStyle`), returning a plain record of
 *    raw CSS values, or `undefined` when the tokens are not there at all (a
 *    host that never mounted `ThemeProvider` and ships no `theme.css`).
 * 2. `buildMermaidThemeVariables(tokens, mode)` turns that record into the
 *    Mermaid base theme (`dark` when the resolved mode is dark, `default`
 *    when light) plus a complete `themeVariables` override: general, flowchart,
 *    sequence, state, class, ER, requirement, gitGraph, gantt, pie, mindmap /
 *    timeline (`cScale*`), journey (`fillType*`), quadrant, xyChart, packet,
 *    radar, wardley, venn, architecture and C4 all derive from the same
 *    tokens. Every colour handed to Mermaid is an opaque hex string, because
 *    Mermaid's colour library does not parse `oklch()`.
 * 3. `applyMermaidTheme(mermaid, key)` is the runtime step `MermaidBlock`
 *    calls before every render: `mermaid.initialize` is global state, so it
 *    runs only when the `(palette, mode)` key changed since the last apply.
 *
 * Fallback contract (hosts): when no tokens resolve, the runtime keeps the
 * static `MERMAID_CONFIG` it was initialized with, and nothing is
 * re-initialized, so a host that does not use Plannotator's theme tokens
 * renders exactly as before this module existed.
 *
 * Contrast rule (the "guard"): every text-on-fill pair the mapping produces
 * must reach WCAG 4.5:1 and every line-on-canvas pair 3:1. A pair that falls
 * short is repaired by moving the text (or line) colour toward the mode's
 * `foreground` token, the smallest step that satisfies the ratio so hue is
 * kept where possible; when `foreground` itself cannot reach the ratio on that
 * fill (a light fill in dark mode), the `background` token is used as the ink
 * instead, and when neither token reaches it pure black or white is the last
 * resort (a mid-luminance fill such as the line colour under a sequence
 * number). Ratios are measured on the 8-bit colour Mermaid receives, never on
 * the unrounded mix. Categorical fills (pie slices, branch lines, mindmap
 * sections, journey tasks) are normalized to one lightness per page polarity
 * (0.74 on a dark page, 0.50 on a light one, chroma clamped to 0.06..0.15) so
 * a single ink, the `background` token, reads on all of them; each fill is
 * additionally pushed in lightness until that ink reaches 4.5:1. Polarity is
 * the measured luminance of the `background` token, not the mode label, so a
 * dark-only palette rendered under a light label still gets fills its ink can
 * carry; the mode label only picks the Mermaid base theme. Structural strokes (node, cluster, actor
 * borders) are guaranteed 1.5:1 against the canvas, nudged toward
 * `muted-foreground`, so a palette with a near-invisible `border` still draws
 * node outlines.
 */
import type { Mermaid, MermaidConfig } from 'mermaid';
import { MERMAID_CONFIG } from './mermaid';
import {
  compositeOver,
  contrastRatio,
  hueDistance,
  mixOklab,
  oklchToRgb,
  parseCssColor,
  parseOpaqueColor,
  quantize,
  relativeLuminance,
  rgbToOklch,
  rotateHue,
  toHex,
  withOklchLightness,
  type RgbColor,
} from './cssColor';

export type MermaidThemeMode = 'light' | 'dark';

/** The custom properties the mapping reads (without the `--` prefix). */
export const MERMAID_THEME_TOKEN_NAMES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'border',
  'muted',
  'muted-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'accent',
  'destructive',
  'success',
  'warning',
  'font-sans',
] as const;

export type MermaidThemeTokenName = (typeof MERMAID_THEME_TOKEN_NAMES)[number];

/** Raw CSS values keyed by token name, as read off the document. */
export type MermaidThemeTokens = Partial<Record<MermaidThemeTokenName, string>>;

export interface MermaidThemeSpec {
  theme: 'dark' | 'default';
  themeVariables: Record<string, unknown>;
}

/** WCAG minimums the guard enforces. */
export const MERMAID_TEXT_CONTRAST_MIN = 4.5;
export const MERMAID_LINE_CONTRAST_MIN = 3;
export const MERMAID_BORDER_CONTRAST_MIN = 1.5;

/** Target OKLCH lightness of categorical fills per mode (see module doc). */
const CATEGORICAL_LIGHTNESS: Record<MermaidThemeMode, number> = { dark: 0.74, light: 0.5 };
const CATEGORICAL_MAX_CHROMA = 0.15;
const CATEGORICAL_MIN_CHROMA = 0.06;
const CATEGORICAL_COUNT = 12;
/** Hues closer than this (degrees) are treated as the same family. */
const HUE_SEPARATION = 18;
/** Opacity of the diagram container's `bg-muted/30` tint over the page. */
const CANVAS_MUTED_ALPHA = 0.3;

// ---------------------------------------------------------------------------
// Token reading (browser)
// ---------------------------------------------------------------------------

/**
 * Read the theme tokens off `el` (default: the document element, where
 * `ThemeProvider` puts the `theme-*` / `light` classes). A value the parser
 * does not understand (`color-mix()`, a `var()` chain) is resolved through a
 * throwaway probe element so the engine does the substitution. Returns
 * `undefined` when neither `--background` nor `--foreground` resolves, which
 * is the signal to keep the static config.
 */
export function readThemeTokens(el?: Element | null): MermaidThemeTokens | undefined {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return undefined;
  const target = el ?? document.documentElement;
  if (!target) return undefined;
  let computed: CSSStyleDeclaration;
  try {
    computed = getComputedStyle(target);
  } catch {
    return undefined;
  }
  const tokens: MermaidThemeTokens = {};
  let probe: HTMLElement | null = null;
  try {
    for (const name of MERMAID_THEME_TOKEN_NAMES) {
      let raw = '';
      try {
        raw = computed.getPropertyValue(`--${name}`).trim();
      } catch {
        raw = '';
      }
      if (!raw) continue;
      if (name === 'font-sans') {
        tokens[name] = raw;
        continue;
      }
      if (parseCssColor(raw)) {
        tokens[name] = raw;
        continue;
      }
      // Unparsable as written: let the engine resolve it to a colour.
      try {
        if (!probe) {
          probe = document.createElement('span');
          probe.setAttribute('aria-hidden', 'true');
          probe.style.position = 'absolute';
          probe.style.width = '0';
          probe.style.height = '0';
          probe.style.overflow = 'hidden';
          probe.style.pointerEvents = 'none';
          target.appendChild(probe);
        }
        probe.style.color = `var(--${name})`;
        const resolved = getComputedStyle(probe).color.trim();
        if (resolved && parseCssColor(resolved)) tokens[name] = resolved;
      } catch {
        // leave the token absent
      }
    }
  } finally {
    probe?.remove();
  }
  if (!tokens.background || !tokens.foreground) return undefined;
  return tokens;
}

// ---------------------------------------------------------------------------
// Mapping (pure)
// ---------------------------------------------------------------------------

interface Palette {
  canvas: RgbColor;
  background: RgbColor;
  foreground: RgbColor;
  card: RgbColor;
  cardForeground: RgbColor;
  popover: RgbColor;
  border: RgbColor;
  muted: RgbColor;
  mutedForeground: RgbColor;
  primary: RgbColor;
  primaryForeground: RgbColor;
  secondary: RgbColor;
  accent: RgbColor;
  destructive: RgbColor;
  success: RgbColor;
  warning: RgbColor;
  fontFamily: string | undefined;
}

/**
 * Parse the tokens into opaque colours, filling gaps from the two required
 * ones so the mapping below is total. Alpha (e.g. a `#ffffff99`
 * muted-foreground) is composited over the page background.
 */
function resolvePalette(tokens: MermaidThemeTokens): Palette | null {
  const background = parseCssColor(tokens.background);
  if (!background) return null;
  const opaqueBackground = compositeOver(background, { r: 1, g: 1, b: 1, a: 1 });
  const foreground = parseOpaqueColor(tokens.foreground, opaqueBackground);
  if (!foreground) return null;
  const over = (value: string | undefined, fallback: RgbColor): RgbColor =>
    parseOpaqueColor(value, opaqueBackground) ?? fallback;
  const towardFg = (t: number): RgbColor => mixOklab(opaqueBackground, foreground, t);

  const card = over(tokens.card, opaqueBackground);
  const muted = over(tokens.muted, towardFg(0.08));
  const primary = over(tokens.primary, foreground);
  const canvas = compositeOver({ ...muted, a: CANVAS_MUTED_ALPHA }, opaqueBackground);
  const font = tokens['font-sans']?.trim();

  return {
    canvas,
    background: opaqueBackground,
    foreground,
    card,
    cardForeground: over(tokens['card-foreground'], foreground),
    popover: over(tokens.popover, card),
    border: over(tokens.border, towardFg(0.2)),
    muted,
    mutedForeground: over(tokens['muted-foreground'], towardFg(0.7)),
    primary,
    primaryForeground: over(tokens['primary-foreground'], opaqueBackground),
    secondary: over(tokens.secondary, muted),
    accent: over(tokens.accent, primary),
    destructive: over(tokens.destructive, parseCssColor('#e5484d') as RgbColor),
    success: over(tokens.success, parseCssColor('#3fb950') as RgbColor),
    warning: over(tokens.warning, parseCssColor('#d29922') as RgbColor),
    fontFamily: font || undefined,
  };
}

/**
 * Repair `color` against `against` until the pair reaches `min`, by the
 * smallest OKLab step toward the first ink that can reach it (see the module
 * doc for the rule). Returns `color` unchanged when it already passes.
 */
export function ensureContrast(color: RgbColor, against: RgbColor, min: number, inks: readonly RgbColor[]): RgbColor {
  const start = quantize(color);
  const fill = quantize(against);
  if (contrastRatio(start, fill) >= min) return start;
  let best: RgbColor = start;
  let bestRatio = contrastRatio(start, fill);
  // The tokens first; pure black and white are the last resort for a
  // mid-luminance fill that neither token can carry text on.
  for (const ink of [...inks, BLACK, WHITE]) {
    const inkRatio = contrastRatio(ink, fill);
    if (inkRatio < min) {
      if (inkRatio > bestRatio) {
        best = ink;
        bestRatio = inkRatio;
      }
      continue;
    }
    // Binary search the smallest mix toward this ink that passes, measured
    // on the 8-bit colour Mermaid will receive.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (contrastRatio(quantize(mixOklab(start, ink, mid)), fill) >= min) hi = mid;
      else lo = mid;
    }
    return quantize(mixOklab(start, ink, hi));
  }
  return quantize(best);
}

const BLACK: RgbColor = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: RgbColor = { r: 1, g: 1, b: 1, a: 1 };

/**
 * Whether the page reads as dark: the luminance at which black and white
 * text contrast equally (about 0.179). Decided from the background token's
 * measured luminance rather than the mode label, so a dark-only palette that
 * a host renders under a light label still gets fills its ink can carry.
 */
export function isDarkBackground(background: RgbColor): boolean {
  return relativeLuminance(background) < 0.179;
}

/**
 * Push a fill's lightness away from `ink` until `ink` reads on it at 4.5:1.
 * Used for the categorical scale, whose single ink is fixed per mode.
 */
function fitFillForInk(fill: RgbColor, ink: RgbColor, polarity: MermaidThemeMode): RgbColor {
  let current = quantize(fill);
  const step = polarity === 'dark' ? 0.02 : -0.02;
  for (let i = 0; i < 24 && contrastRatio(ink, current) < MERMAID_TEXT_CONTRAST_MIN; i++) {
    const L = rgbToOklch(current).L + step;
    if (L < 0.05 || L > 0.98) break;
    current = quantize(withOklchLightness(current, L));
  }
  return current;
}

/**
 * Twelve categorical fills for pie / git / mindmap / journey / timeline,
 * seeded from the palette's own accent tokens (in order: primary, accent,
 * success, warning, destructive, secondary; greys skipped) and filled out with
 * hue rotations of the first seed, all normalized to one lightness and a
 * chroma band so they read as one family and share one ink.
 */
export function buildCategoricalScale(p: Palette, polarity: MermaidThemeMode): RgbColor[] {
  const targetL = CATEGORICAL_LIGHTNESS[polarity];
  const normalize = (c: RgbColor): RgbColor => {
    const lch = rgbToOklch(c);
    const C = Math.min(CATEGORICAL_MAX_CHROMA, Math.max(CATEGORICAL_MIN_CHROMA, lch.C));
    return { ...oklchToRgb({ L: targetL, C, H: lch.H }), a: 1 };
  };
  const hues: number[] = [];
  const out: RgbColor[] = [];
  const push = (c: RgbColor): void => {
    const h = rgbToOklch(c).H;
    if (hues.some((existing) => hueDistance(existing, h) < HUE_SEPARATION)) return;
    hues.push(h);
    out.push(normalize(c));
  };
  const seeds = [p.primary, p.accent, p.success, p.warning, p.destructive, p.secondary];
  for (const seed of seeds) {
    if (rgbToOklch(seed).C >= 0.05) push(seed);
    if (out.length >= CATEGORICAL_COUNT) break;
  }
  // A grey palette (no chromatic seed) still gets a scale: start from a
  // mid-chroma blue-violet so slices stay tellable apart.
  const base: RgbColor = out.length ? out[0] : { ...withOklchLightness(parseCssColor('#7c7cff') as RgbColor, targetL), a: 1 };
  if (!out.length) push(base);
  for (let k = 1; out.length < CATEGORICAL_COUNT && k < 40; k++) {
    // Golden-angle-ish stepping spreads the rotations before wrapping.
    push(rotateHue(base, (k * 137.5) % 360));
  }
  // Every fill must carry the mode ink at 4.5:1.
  return out.slice(0, CATEGORICAL_COUNT).map((c) => fitFillForInk(c, p.background, polarity));
}

/**
 * Derive the Mermaid base theme and a total `themeVariables` override from
 * the tokens. Returns `null` when the required tokens are missing or
 * unparsable, which callers treat as "use the static config".
 */
export function buildMermaidThemeVariables(tokens: MermaidThemeTokens | undefined, mode: MermaidThemeMode): MermaidThemeSpec | null {
  if (!tokens) return null;
  const p = resolvePalette(tokens);
  if (!p) return null;

  // Base theme follows the mode; fill lightness and ink follow the measured page.
  const polarity: MermaidThemeMode = isDarkBackground(p.background) ? 'dark' : 'light';
  const inks = [p.foreground, p.background] as const;
  const text = (color: RgbColor, fill: RgbColor): RgbColor => ensureContrast(color, fill, MERMAID_TEXT_CONTRAST_MIN, inks);
  const line = (color: RgbColor): RgbColor => ensureContrast(color, p.canvas, MERMAID_LINE_CONTRAST_MIN, inks);
  const stroke = (color: RgbColor): RgbColor =>
    ensureContrast(color, p.canvas, MERMAID_BORDER_CONTRAST_MIN, [p.mutedForeground, p.foreground]);

  const canvas = p.canvas;
  const fg = text(p.foreground, canvas);
  const cardText = text(p.cardForeground, p.card);
  const mutedText = text(p.foreground, p.muted);
  const popoverText = text(p.foreground, p.popover);
  const lineColor = line(p.mutedForeground);
  const nodeBorder = stroke(p.border);
  const clusterBorder = stroke(p.border);
  const primaryLine = line(p.primary);
  const destructiveLine = line(p.destructive);
  const warningLine = line(p.warning);
  // A note is a card tinted toward the warning token, so it stays a surface
  // its own text reads on rather than a fixed yellow.
  const noteBg = mixOklab(p.card, p.warning, 0.18);
  const noteText = text(p.cardForeground, noteBg);
  const rowEven = mixOklab(p.card, p.muted, 0.6);
  const errorBg = mixOklab(p.card, p.destructive, 0.25);
  const errorText = text(p.foreground, errorBg);
  // Ink on a line-coloured shape (sequence numbers sit on `lineColor` discs).
  const onLine = text(p.background, lineColor);

  const scale = buildCategoricalScale(p, polarity);
  const scaleInk = p.background;
  const scaleHex = scale.map(toHex);
  const scalePeer = scale.map((c) => toHex(mixOklab(c, scaleInk, 0.25)));
  const scaleLabel = scale.map((c) => toHex(text(scaleInk, c)));

  const h = toHex;
  const vars: Record<string, unknown> = {
    darkMode: mode === 'dark',
    ...(p.fontFamily ? { fontFamily: p.fontFamily } : {}),

    // General
    background: h(canvas),
    primaryColor: h(p.card),
    primaryTextColor: h(cardText),
    primaryBorderColor: h(nodeBorder),
    secondaryColor: h(p.muted),
    secondaryTextColor: h(mutedText),
    secondaryBorderColor: h(nodeBorder),
    tertiaryColor: h(p.popover),
    tertiaryTextColor: h(popoverText),
    tertiaryBorderColor: h(nodeBorder),
    textColor: h(fg),
    titleColor: h(fg),
    labelColor: h(fg),
    mainContrastColor: h(fg),
    darkTextColor: h(text(p.background, p.foreground)),
    lineColor: h(lineColor),
    arrowheadColor: h(lineColor),
    defaultLinkColor: h(lineColor),
    mainBkg: h(p.card),
    secondBkg: h(p.muted),
    border1: h(nodeBorder),
    border2: h(clusterBorder),
    labelBackground: h(canvas),
    errorBkgColor: h(errorBg),
    errorTextColor: h(errorText),
    useGradient: false,

    // Flowchart
    nodeBkg: h(p.card),
    nodeBorder: h(nodeBorder),
    nodeTextColor: h(cardText),
    clusterBkg: h(p.muted),
    clusterBorder: h(clusterBorder),
    edgeLabelBackground: h(canvas),

    // Sequence
    actorBkg: h(p.card),
    actorBorder: h(nodeBorder),
    actorTextColor: h(cardText),
    actorLineColor: h(lineColor),
    signalColor: h(lineColor),
    signalTextColor: h(fg),
    labelBoxBkgColor: h(p.muted),
    // Also strokes the dashed loop/alt frame (`.loopLine`), a real line.
    labelBoxBorderColor: h(lineColor),
    labelTextColor: h(mutedText),
    loopTextColor: h(mutedText),
    noteBkgColor: h(noteBg),
    noteBorderColor: h(warningLine),
    noteTextColor: h(noteText),
    activationBkgColor: h(p.muted),
    activationBorderColor: h(nodeBorder),
    sequenceNumberColor: h(onLine),

    // State
    stateBkg: h(p.card),
    stateLabelColor: h(cardText),
    transitionColor: h(lineColor),
    transitionLabelColor: h(fg),
    labelBackgroundColor: h(p.card),
    compositeBackground: h(p.muted),
    compositeTitleBackground: h(p.muted),
    compositeBorder: h(nodeBorder),
    altBackground: h(p.card),
    innerEndBackground: h(lineColor),
    specialStateColor: h(lineColor),

    // Class
    classText: h(cardText),

    // ER
    attributeBackgroundColorOdd: h(p.card),
    attributeBackgroundColorEven: h(rowEven),
    rowOdd: h(p.card),
    rowEven: h(rowEven),

    // Requirement
    requirementBackground: h(p.card),
    requirementBorderColor: h(nodeBorder),
    requirementTextColor: h(cardText),
    relationColor: h(lineColor),
    relationLabelBackground: h(canvas),
    relationLabelColor: h(fg),

    // Git
    commitLabelColor: h(fg),
    commitLabelBackground: h(canvas),
    tagLabelColor: h(cardText),
    tagLabelBackground: h(p.card),
    tagLabelBorder: h(nodeBorder),

    // Gantt
    sectionBkgColor: h(p.muted),
    altSectionBkgColor: h(canvas),
    sectionBkgColor2: h(p.card),
    excludeBkgColor: h(p.muted),
    taskBorderColor: h(nodeBorder),
    taskBkgColor: scaleHex[0],
    taskTextColor: scaleLabel[0],
    taskTextLightColor: h(fg),
    taskTextDarkColor: scaleLabel[0],
    taskTextOutsideColor: h(fg),
    taskTextClickableColor: h(text(p.primary, canvas)),
    activeTaskBorderColor: h(primaryLine),
    activeTaskBkgColor: scaleHex[1] ?? scaleHex[0],
    gridColor: h(nodeBorder),
    doneTaskBkgColor: h(p.muted),
    doneTaskBorderColor: h(nodeBorder),
    critBorderColor: h(destructiveLine),
    critBkgColor: h(fitFillForInk(withOklchLightness(p.destructive, CATEGORICAL_LIGHTNESS[polarity]), scaleInk, polarity)),
    todayLineColor: h(destructiveLine),
    vertLineColor: h(primaryLine),

    // Pie
    pieTitleTextColor: h(fg),
    pieSectionTextColor: h(text(scaleInk, scale[0])),
    pieLegendTextColor: h(fg),
    pieStrokeColor: h(canvas),
    pieOuterStrokeColor: h(nodeBorder),
    pieOpacity: '1',

    // Quadrant
    quadrant1Fill: h(p.card),
    quadrant2Fill: h(p.muted),
    quadrant3Fill: h(p.muted),
    quadrant4Fill: h(p.card),
    quadrant1TextFill: h(cardText),
    quadrant2TextFill: h(mutedText),
    quadrant3TextFill: h(mutedText),
    quadrant4TextFill: h(cardText),
    quadrantPointFill: h(primaryLine),
    quadrantPointTextFill: h(fg),
    quadrantXAxisTextFill: h(fg),
    quadrantYAxisTextFill: h(fg),
    quadrantInternalBorderStrokeFill: h(nodeBorder),
    quadrantExternalBorderStrokeFill: h(nodeBorder),
    quadrantTitleFill: h(fg),

    // Architecture / C4
    archEdgeColor: h(lineColor),
    archEdgeArrowColor: h(lineColor),
    archGroupBorderColor: h(nodeBorder),
    personBkg: h(p.card),
    personBorder: h(nodeBorder),

    // Venn
    vennTitleTextColor: h(fg),
    vennSetTextColor: h(fg),

    // Event modeling
    emUiFill: h(p.card),
    emUiStroke: h(nodeBorder),
    emProcessorFill: scaleHex[3] ?? scaleHex[0],
    emProcessorStroke: h(lineColor),
    emReadModelFill: scaleHex[2] ?? scaleHex[0],
    emReadModelStroke: h(lineColor),
    emCommandFill: scaleHex[0],
    emCommandStroke: h(lineColor),
    emEventFill: scaleHex[1] ?? scaleHex[0],
    emEventStroke: h(lineColor),
    emSwimlaneBackgroundOdd: h(canvas),
    emSwimlaneBackgroundStroke: h(nodeBorder),
    emArrowhead: h(lineColor),
    emRelationStroke: h(lineColor),

    // Scale-driven families
    scaleLabelColor: scaleLabel[0],
    xyChart: {
      backgroundColor: h(canvas),
      titleColor: h(fg),
      dataLabelColor: h(fg),
      legendTextColor: h(fg),
      xAxisTitleColor: h(fg),
      xAxisLabelColor: h(fg),
      xAxisTickColor: h(lineColor),
      xAxisLineColor: h(lineColor),
      yAxisTitleColor: h(fg),
      yAxisLabelColor: h(fg),
      yAxisTickColor: h(lineColor),
      yAxisLineColor: h(lineColor),
      plotColorPalette: scaleHex.join(','),
    },
    packet: {
      startByteColor: h(fg),
      endByteColor: h(fg),
      labelColor: h(cardText),
      titleColor: h(fg),
      blockStrokeColor: h(nodeBorder),
      blockFillColor: h(p.card),
    },
    radar: {
      axisColor: h(lineColor),
      graticuleColor: h(nodeBorder),
    },
    wardley: {
      backgroundColor: h(canvas),
      axisColor: h(lineColor),
      axisTextColor: h(fg),
      gridColor: h(nodeBorder),
      componentFill: h(p.card),
      componentStroke: h(lineColor),
      componentLabelColor: h(fg),
      linkStroke: h(lineColor),
      evolutionStroke: h(destructiveLine),
      annotationStroke: h(lineColor),
      annotationTextColor: h(fg),
      annotationFill: h(p.card),
    },
    cynefin: {
      boundaryColor: h(lineColor),
      cliffColor: h(destructiveLine),
      arrowColor: h(lineColor),
      textColor: h(fg),
      labelColor: h(fg),
      complexBg: scaleHex[0],
      complicatedBg: scaleHex[1] ?? scaleHex[0],
      chaoticBg: h(fitFillForInk(withOklchLightness(p.destructive, CATEGORICAL_LIGHTNESS[polarity]), scaleInk, polarity)),
      clearBg: h(fitFillForInk(withOklchLightness(p.success, CATEGORICAL_LIGHTNESS[polarity]), scaleInk, polarity)),
      confusionBg: scaleHex[2] ?? scaleHex[0],
    },
  };

  for (let i = 0; i < CATEGORICAL_COUNT; i++) {
    vars[`cScale${i}`] = scaleHex[i];
    vars[`cScaleInv${i}`] = scaleLabel[i];
    vars[`cScalePeer${i}`] = scalePeer[i];
    vars[`cScaleLabel${i}`] = scaleLabel[i];
    vars[`pie${i + 1}`] = scaleHex[i];
  }
  for (let i = 0; i < 8; i++) {
    vars[`git${i}`] = scaleHex[i];
    vars[`gitInv${i}`] = scaleLabel[i];
    vars[`gitBranchLabel${i}`] = scaleLabel[i];
    vars[`fillType${i}`] = scaleHex[i];
    vars[`venn${i + 1}`] = scaleHex[i];
  }
  return { theme: mode === 'dark' ? 'dark' : 'default', themeVariables: vars };
}

/** The full Mermaid config for a spec: `MERMAID_CONFIG` with the theme swapped. */
export function buildMermaidConfig(spec: MermaidThemeSpec | null): MermaidConfig {
  if (!spec) return MERMAID_CONFIG;
  return { ...MERMAID_CONFIG, theme: spec.theme, themeVariables: spec.themeVariables };
}

// ---------------------------------------------------------------------------
// Runtime application (cached by key)
// ---------------------------------------------------------------------------

/** `mode:palette`, the cache key `applyMermaidTheme` compares. */
export function mermaidThemeKey(colorTheme: string, mode: MermaidThemeMode): string {
  return `${mode}:${colorTheme}`;
}

function modeFromKey(key: string): MermaidThemeMode {
  return key.startsWith('light:') ? 'light' : 'dark';
}

export type MermaidThemeApplyResult = 'unchanged' | 'dynamic' | 'static';

let appliedRuntime: Pick<Mermaid, 'initialize'> | null = null;
let appliedKey: string | null = null;
let appliedKind: 'dynamic' | 'static' | null = null;

/**
 * Initialize `mermaid` for the `(palette, mode)` named by `key`, once per key
 * change. Reads the tokens from `root` (default: the document element). With
 * no tokens the runtime is left on the static config it was initialized with
 * (no `initialize` call at all unless a dynamic theme was applied earlier),
 * which is the fallback contract for hosts.
 */
export function applyMermaidTheme(
  mermaid: Pick<Mermaid, 'initialize'>,
  key: string,
  root?: Element | null,
): MermaidThemeApplyResult {
  if (appliedRuntime === mermaid && appliedKey === key) return 'unchanged';
  const spec = buildMermaidThemeVariables(readThemeTokens(root), modeFromKey(key));
  const sameRuntime = appliedRuntime === mermaid;
  appliedRuntime = mermaid;
  appliedKey = key;
  if (!spec) {
    if (sameRuntime && appliedKind === 'dynamic') mermaid.initialize(MERMAID_CONFIG);
    appliedKind = 'static';
    return 'static';
  }
  mermaid.initialize(buildMermaidConfig(spec));
  appliedKind = 'dynamic';
  return 'dynamic';
}

/** Test hook: forget the last applied key so the next apply re-initializes. */
export function __resetMermaidThemeForTests(): void {
  appliedRuntime = null;
  appliedKey = null;
  appliedKind = null;
}
