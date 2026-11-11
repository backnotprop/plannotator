/**
 * Contrast rule (the "guard"): every text-on-fill pair the mapping produces must reach WCAG
 * 4.5:1 and every line-on-canvas pair 3:1 (plus a 0.1 headroom, `GUARD_HEADROOM`).
 */
import type { Mermaid, MermaidConfig } from 'mermaid';
import { MERMAID_CONFIG } from './mermaid';
import { readThemeTokenValues } from './themeTokens';
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
  shadowAmount: number;
}

/** Options `buildMermaidThemeVariables` accepts beyond the tokens and mode. */
export interface MermaidThemeOptions {
  readonly shadowAmount?: number;
}

export const DEFAULT_MERMAID_SHADOW_AMOUNT = 0.7;

/** Mermaid 12's own node shadow, the colour included. */
export const MERMAID_DEFAULT_SHADOW_COLOR = 'rgba(185, 185, 185, 1)';

/** Clamp an amount to 0..1 and round it, so it is stable in a cache key. */
export function clampShadowAmount(amount: number | undefined): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return DEFAULT_MERMAID_SHADOW_AMOUNT;
  return Math.round(Math.min(1, Math.max(0, amount)) * 1000) / 1000;
}

/** WCAG minimums the guard enforces. */
export const MERMAID_TEXT_CONTRAST_MIN = 4.5;
export const MERMAID_LINE_CONTRAST_MIN = 3;
export const MERMAID_BORDER_CONTRAST_MIN = 1.5;
const GUARD_HEADROOM = 0.1;

const CATEGORICAL_LIGHTNESS: Record<MermaidThemeMode, number> = { dark: 0.74, light: 0.5 };
const CATEGORICAL_MAX_CHROMA = 0.15;
const CATEGORICAL_MIN_CHROMA = 0.06;
const CATEGORICAL_COUNT = 12;
const HUE_SEPARATION = 18;
const CANVAS_MUTED_ALPHA = 0.3;

/**
 * Read the theme tokens off `el` (default: the document element, where `ThemeProvider` puts the
 * `theme-*` / `light` classes).
 */
export function readThemeTokens(el?: Element | null): MermaidThemeTokens | undefined {
  const tokens: MermaidThemeTokens | undefined = readThemeTokenValues(MERMAID_THEME_TOKEN_NAMES, el, ['font-sans']);
  if (!tokens?.background || !tokens.foreground) return undefined;
  return tokens;
}

interface Palette {
  canvas: RgbColor;
  canvasOnBackground: RgbColor;
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
  const canvas = compositeOver({ ...muted, a: CANVAS_MUTED_ALPHA }, card);
  const canvasOnBackground = compositeOver({ ...muted, a: CANVAS_MUTED_ALPHA }, opaqueBackground);
  const font = tokens['font-sans']?.trim();

  return {
    canvas,
    canvasOnBackground,
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

/** Returns `color` unchanged when it already passes. */
export function ensureContrast(color: RgbColor, against: RgbColor, min: number, inks: readonly RgbColor[]): RgbColor {
  const start = quantize(color);
  const fill = quantize(against);
  if (contrastRatio(start, fill) >= min) return start;
  let best: RgbColor = start;
  let bestRatio = contrastRatio(start, fill);
  for (const ink of [...inks, BLACK, WHITE]) {
    const inkRatio = contrastRatio(ink, fill);
    if (inkRatio < min) {
      if (inkRatio > bestRatio) {
        best = ink;
        bestRatio = inkRatio;
      }
      continue;
    }
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
 * Whether the page reads as dark: the luminance at which black and white text contrast equally
 * (about 0.179).
 */
export function isDarkBackground(background: RgbColor): boolean {
  return relativeLuminance(background) < 0.179;
}

function rgba(c: RgbColor, alpha: number): string {
  const ch = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${Math.round(alpha * 1000) / 1000})`;
}

/**
 * The node drop shadow, as the `drop-shadow(x y blur colour)` string Mermaid's `dropShadow`
 * theme variable takes, or `false` — its falsy value.
 */
export function buildMermaidShadow(ground: RgbColor | undefined, amount: number): string | false {
  const a = clampShadowAmount(amount);
  if (a <= 0) return false;
  const round = (v: number) => Math.round(v * 100) / 100;
  const geometry = `${round(0.3 + 0.7 * a)}px ${round(0.6 + 1.4 * a)}px ${round(0.6 + 1.4 * a)}px`;
  const usable =
    ground !== undefined &&
    Number.isFinite(ground.r) &&
    Number.isFinite(ground.g) &&
    Number.isFinite(ground.b);
  if (!usable) return `drop-shadow(${geometry} ${MERMAID_DEFAULT_SHADOW_COLOR})`;
  const dark = isDarkBackground(ground);
  let colour = dark ? mixOklab(ground, WHITE, 0.82) : mixOklab(ground, BLACK, 0.4);
  const alpha = dark ? 0.18 + 0.72 * a : 0.25 + 0.3 * a;
  const groundL = relativeLuminance(ground);
  if (dark && relativeLuminance(colour) <= groundL) colour = WHITE;
  if (!dark && relativeLuminance(colour) >= groundL) colour = BLACK;
  return `drop-shadow(${geometry} ${rgba(colour, alpha)})`;
}

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
 * Twelve categorical fills for pie / git / mindmap / journey / timeline, seeded from the
 * palette's own accent tokens (in order: primary, accent, success, warning.
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
  const base: RgbColor = out.length ? out[0] : { ...withOklchLightness(parseCssColor('#7c7cff') as RgbColor, targetL), a: 1 };
  if (!out.length) push(base);
  for (let k = 1; out.length < CATEGORICAL_COUNT && k < 40; k++) {
    push(rotateHue(base, (k * 137.5) % 360));
  }
  // Every fill must carry the mode ink at 4.5:1.
  return out.slice(0, CATEGORICAL_COUNT).map((c) => fitFillForInk(c, p.background, polarity));
}

/** Derive the Mermaid base theme and a total `themeVariables` override from the tokens. */
export function buildMermaidThemeVariables(
  tokens: MermaidThemeTokens | undefined,
  mode: MermaidThemeMode,
  options?: MermaidThemeOptions,
): MermaidThemeSpec | null {
  if (!tokens) return null;
  const p = resolvePalette(tokens);
  if (!p) return null;
  const shadowAmount = clampShadowAmount(options?.shadowAmount);

  const polarity: MermaidThemeMode = isDarkBackground(p.background) ? 'dark' : 'light';
  const inks = [p.foreground, p.background] as const;
  const rowEven = mixOklab(p.card, p.muted, 0.6);
  const surfaces = [p.canvas, p.canvasOnBackground, p.card, p.muted, p.popover, rowEven] as const;
  const textMin = MERMAID_TEXT_CONTRAST_MIN + GUARD_HEADROOM;
  const lineMin = MERMAID_LINE_CONTRAST_MIN + GUARD_HEADROOM;
  const text = (color: RgbColor, fill: RgbColor): RgbColor => ensureContrast(color, fill, textMin, inks);
  const textOnSurfaces = (color: RgbColor): RgbColor =>
    surfaces.reduce((c, surface) => ensureContrast(c, surface, textMin, inks), quantize(color));
  const line = (color: RgbColor): RgbColor =>
    [p.canvas, p.canvasOnBackground, p.muted, p.card].reduce((c, surface) => ensureContrast(c, surface, lineMin, inks), quantize(color));
  const stroke = (color: RgbColor): RgbColor =>
    ensureContrast(color, p.canvas, MERMAID_BORDER_CONTRAST_MIN, [p.mutedForeground, p.foreground]);

  const canvas = p.canvas;
  const fg = textOnSurfaces(p.foreground);
  const cardText = textOnSurfaces(p.cardForeground);
  const mutedText = cardText;
  const popoverText = cardText;
  const lineColor = line(p.mutedForeground);
  const nodeBorder = stroke(p.border);
  const clusterBorder = stroke(p.border);
  const primaryLine = line(p.primary);
  const destructiveLine = line(p.destructive);
  const warningLine = line(p.warning);
  const noteBg = mixOklab(p.card, p.warning, 0.18);
  const noteText = text(p.cardForeground, noteBg);
  const errorBg = mixOklab(p.card, p.destructive, 0.25);
  const errorText = text(p.foreground, errorBg);
  const onLine = text(p.background, lineColor);

  const scale = buildCategoricalScale(p, polarity);
  const scaleInk = p.background;
  const scaleHex = scale.map(toHex);
  const scalePeer = scale.map((c) => toHex(mixOklab(c, scaleInk, 0.25)));
  const scaleLabel = scale.map((c) => toHex(text(scaleInk, c)));

  const h = toHex;
  const shadow = buildMermaidShadow(p.background, shadowAmount);
  const vars: Record<string, unknown> = {
    darkMode: mode === 'dark',
    ...(p.fontFamily ? { fontFamily: p.fontFamily } : {}),

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
    // Paint-time only: a filter on the shape, never a fill or a label colour.
    dropShadow: shadow,
    ...(shadow === false ? { nodeShadow: false } : {}),

    nodeBkg: h(p.card),
    nodeBorder: h(nodeBorder),
    nodeTextColor: h(cardText),
    clusterBkg: h(p.muted),
    clusterBorder: h(clusterBorder),
    edgeLabelBackground: h(canvas),

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

    classText: h(cardText),

    attributeBackgroundColorOdd: h(p.card),
    attributeBackgroundColorEven: h(rowEven),
    rowOdd: h(p.card),
    rowEven: h(rowEven),

    requirementBackground: h(p.card),
    requirementBorderColor: h(nodeBorder),
    requirementTextColor: h(cardText),
    relationColor: h(lineColor),
    relationLabelBackground: h(canvas),
    relationLabelColor: h(fg),

    commitLabelColor: h(fg),
    commitLabelBackground: h(canvas),
    tagLabelColor: h(cardText),
    tagLabelBackground: h(p.card),
    tagLabelBorder: h(nodeBorder),

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

    pieTitleTextColor: h(fg),
    pieSectionTextColor: h(text(scaleInk, scale[0])),
    pieLegendTextColor: h(fg),
    pieStrokeColor: h(canvas),
    pieOuterStrokeColor: h(nodeBorder),
    pieOpacity: '1',

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

    archEdgeColor: h(lineColor),
    archEdgeArrowColor: h(lineColor),
    archGroupBorderColor: h(nodeBorder),
    personBkg: h(p.card),
    personBorder: h(nodeBorder),

    vennTitleTextColor: h(fg),
    vennSetTextColor: h(fg),

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
  return { theme: mode === 'dark' ? 'dark' : 'default', themeVariables: vars, shadowAmount };
}

export function buildMermaidConfig(spec: MermaidThemeSpec | null): MermaidConfig {
  if (!spec) return MERMAID_CONFIG;
  return { ...MERMAID_CONFIG, theme: spec.theme, themeVariables: spec.themeVariables };
}

/**
 * `mode:palette`, the cache key `applyMermaidTheme` compares — plus a `#s<amount>` suffix when
 * the shadow amount is not the shipped default.
 */
export function mermaidThemeKey(
  colorTheme: string,
  mode: MermaidThemeMode,
  shadowAmount: number = DEFAULT_MERMAID_SHADOW_AMOUNT,
): string {
  const amount = clampShadowAmount(shadowAmount);
  const base = `${mode}:${colorTheme}`;
  return amount === DEFAULT_MERMAID_SHADOW_AMOUNT ? base : `${base}#s${amount}`;
}

function modeFromKey(key: string): MermaidThemeMode {
  return key.startsWith('light:') ? 'light' : 'dark';
}

export function shadowAmountFromKey(key: string): number {
  const match = /#s(\d*\.?\d+)$/u.exec(key);
  return match ? clampShadowAmount(Number(match[1])) : DEFAULT_MERMAID_SHADOW_AMOUNT;
}

export type MermaidThemeApplyResult = 'unchanged' | 'dynamic' | 'static';

let appliedRuntime: Pick<Mermaid, 'initialize'> | null = null;
let appliedKey: string | null = null;
let appliedKind: 'dynamic' | 'static' | null = null;

/** Initialize `mermaid` for the `(palette, mode)` named by `key`, once per key change. */
export function applyMermaidTheme(
  mermaid: Pick<Mermaid, 'initialize'>,
  key: string,
  root?: Element | null,
): MermaidThemeApplyResult {
  if (appliedRuntime === mermaid && appliedKey === key) return 'unchanged';
  const spec = buildMermaidThemeVariables(readThemeTokens(root), modeFromKey(key), {
    shadowAmount: shadowAmountFromKey(key),
  });
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
