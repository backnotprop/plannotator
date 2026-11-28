/**
 * Theme-aware Mermaid mapping (utils/mermaidTheme.ts).
 *
 * What regresses if these fail:
 * - a diagram family (sequence, gitGraph, pie, ...) drops out of the mapping
 *   and silently falls back to Mermaid's built-in palette in one theme;
 * - the base theme stops following the resolved mode, so light palettes get
 *   Mermaid's dark derivations for everything the mapping leaves alone;
 * - the fallback contract breaks: a host without theme tokens would get a
 *   dynamic config (or a second `initialize`) instead of today's static one;
 * - the contrast guard stops holding, so a palette whose tokens are close in
 *   luminance ships unreadable labels or invisible edges. The sweep below runs
 *   the guard over every palette shipped in `packages/ui/themes`, in both
 *   modes, so a new palette cannot regress it either.
 *
 * No DOM required: the tokens are read from the theme CSS files as text.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MERMAID_CONFIG, MERMAID_LABEL_WRAP_WIDTH } from './mermaid';
import { compositeOver, contrastRatio, parseCssColor, relativeLuminance, rgbToOklab, toHex, type RgbColor } from './cssColor';
import { DEFAULT_DIAGRAM_SHADOW, DIAGRAM_SHADOW_OPTIONS } from './diagramShadow';
import {
  DEFAULT_MERMAID_SHADOW_AMOUNT,
  MERMAID_LINE_CONTRAST_MIN,
  MERMAID_TEXT_CONTRAST_MIN,
  __resetMermaidThemeForTests,
  applyMermaidTheme,
  buildMermaidConfig,
  buildMermaidShadow,
  buildMermaidThemeVariables,
  ensureContrast,
  isDarkBackground,
  mermaidThemeKey,
  shadowAmountFromKey,
  type MermaidThemeMode,
  type MermaidThemeTokens,
} from './mermaidTheme';

const HEX = /^#[0-9a-f]{6}$/;

/**
 * Every shipped palette, both modes. Reads the tokens straight out of the CSS
 * so a palette added later is swept automatically (by the contrast guard AND
 * by the shadow sweep below).
 */
const themesDir = join(import.meta.dir, '..', 'themes');
const themeFiles = readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort();
expect(themeFiles.length).toBeGreaterThan(30);

/** First rule whose selector list names `selector` (some files write `.theme-x,\n.theme-x.light {`). */
function tokensFromCss(css: string, selector: string): MermaidThemeTokens | undefined {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = rule[1].split(',').map((sel) => sel.trim());
    if (!selectors.includes(selector)) continue;
    const tokens: Record<string, string> = {};
    for (const m of rule[2].matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
    return tokens as MermaidThemeTokens;
  }
  return undefined;
}

/** The Plannotator base palette, as `themes/plannotator.css` writes it. */
const PLANNOTATOR_DARK: MermaidThemeTokens = {
  background: 'oklch(0.15 0.02 260)',
  foreground: 'oklch(0.90 0.01 260)',
  card: 'oklch(0.22 0.02 260)',
  'card-foreground': 'oklch(0.90 0.01 260)',
  popover: 'oklch(0.28 0.025 260)',
  primary: 'oklch(0.75 0.18 280)',
  'primary-foreground': 'oklch(0.15 0.02 260)',
  secondary: 'oklch(0.65 0.15 180)',
  muted: 'oklch(0.26 0.02 260)',
  'muted-foreground': 'oklch(0.72 0.02 260)',
  accent: 'oklch(0.70 0.20 60)',
  destructive: 'oklch(0.65 0.20 25)',
  border: 'oklch(0.35 0.02 260)',
  success: 'oklch(0.72 0.17 150)',
  warning: 'oklch(0.75 0.15 85)',
  'font-sans': "'Inter Variable', 'Inter', system-ui, sans-serif",
};

const PLANNOTATOR_LIGHT: MermaidThemeTokens = {
  background: 'oklch(0.97 0.005 260)',
  foreground: 'oklch(0.18 0.02 260)',
  card: 'oklch(1 0 0)',
  'card-foreground': 'oklch(0.18 0.02 260)',
  popover: 'oklch(1 0 0)',
  primary: 'oklch(0.50 0.25 280)',
  'primary-foreground': 'oklch(1 0 0)',
  secondary: 'oklch(0.50 0.18 180)',
  muted: 'oklch(0.92 0.01 260)',
  'muted-foreground': 'oklch(0.40 0.02 260)',
  accent: 'oklch(0.60 0.22 50)',
  destructive: 'oklch(0.50 0.25 25)',
  border: 'oklch(0.88 0.01 260)',
  success: 'oklch(0.45 0.20 150)',
  warning: 'oklch(0.55 0.18 85)',
};

/**
 * Every theme variable Mermaid documents per family (docs: "Theme Variables",
 * `theme-dark.js` / `theme-default.js` in 11.x). The mapping must set each one
 * explicitly so no family inherits a base-theme derivation from a colour the
 * palette never chose.
 */
const DOCUMENTED_VARIABLES = {
  general: [
    'background', 'primaryColor', 'primaryTextColor', 'primaryBorderColor', 'secondaryColor',
    'secondaryTextColor', 'secondaryBorderColor', 'tertiaryColor', 'tertiaryTextColor',
    'tertiaryBorderColor', 'textColor', 'titleColor', 'lineColor', 'arrowheadColor', 'mainBkg',
    'secondBkg', 'border1', 'border2', 'labelBackground', 'errorBkgColor', 'errorTextColor',
  ],
  flowchart: ['nodeBkg', 'nodeBorder', 'nodeTextColor', 'clusterBkg', 'clusterBorder', 'defaultLinkColor', 'edgeLabelBackground'],
  sequence: [
    'actorBkg', 'actorBorder', 'actorTextColor', 'actorLineColor', 'signalColor', 'signalTextColor',
    'labelBoxBkgColor', 'labelBoxBorderColor', 'labelTextColor', 'loopTextColor', 'noteBkgColor',
    'noteBorderColor', 'noteTextColor', 'activationBkgColor', 'activationBorderColor', 'sequenceNumberColor',
  ],
  state: [
    'stateBkg', 'stateLabelColor', 'transitionColor', 'transitionLabelColor', 'labelBackgroundColor',
    'compositeBackground', 'compositeTitleBackground', 'compositeBorder', 'altBackground',
    'innerEndBackground', 'specialStateColor', 'labelColor',
  ],
  class: ['classText'],
  er: ['attributeBackgroundColorOdd', 'attributeBackgroundColorEven', 'rowOdd', 'rowEven'],
  requirement: ['requirementBackground', 'requirementBorderColor', 'requirementTextColor', 'relationColor', 'relationLabelBackground', 'relationLabelColor'],
  git: [
    ...Array.from({ length: 8 }, (_, i) => `git${i}`),
    ...Array.from({ length: 8 }, (_, i) => `gitInv${i}`),
    ...Array.from({ length: 8 }, (_, i) => `gitBranchLabel${i}`),
    'commitLabelColor', 'commitLabelBackground', 'tagLabelColor', 'tagLabelBackground', 'tagLabelBorder',
  ],
  gantt: [
    'sectionBkgColor', 'altSectionBkgColor', 'sectionBkgColor2', 'excludeBkgColor', 'taskBorderColor',
    'taskBkgColor', 'taskTextColor', 'taskTextLightColor', 'taskTextDarkColor', 'taskTextOutsideColor',
    'taskTextClickableColor', 'activeTaskBorderColor', 'activeTaskBkgColor', 'gridColor', 'doneTaskBkgColor',
    'doneTaskBorderColor', 'critBorderColor', 'critBkgColor', 'todayLineColor', 'vertLineColor',
  ],
  pie: [
    ...Array.from({ length: 12 }, (_, i) => `pie${i + 1}`),
    'pieTitleTextColor', 'pieSectionTextColor', 'pieLegendTextColor', 'pieStrokeColor', 'pieOuterStrokeColor',
  ],
  scale: [
    ...Array.from({ length: 12 }, (_, i) => `cScale${i}`),
    ...Array.from({ length: 12 }, (_, i) => `cScaleInv${i}`),
    ...Array.from({ length: 12 }, (_, i) => `cScalePeer${i}`),
    ...Array.from({ length: 12 }, (_, i) => `cScaleLabel${i}`),
    'scaleLabelColor',
  ],
  journey: Array.from({ length: 8 }, (_, i) => `fillType${i}`),
  quadrant: [
    'quadrant1Fill', 'quadrant2Fill', 'quadrant3Fill', 'quadrant4Fill', 'quadrant1TextFill', 'quadrant2TextFill',
    'quadrant3TextFill', 'quadrant4TextFill', 'quadrantPointFill', 'quadrantPointTextFill', 'quadrantXAxisTextFill',
    'quadrantYAxisTextFill', 'quadrantInternalBorderStrokeFill', 'quadrantExternalBorderStrokeFill', 'quadrantTitleFill',
  ],
  architecture: ['archEdgeColor', 'archEdgeArrowColor', 'archGroupBorderColor'],
  c4: ['personBkg', 'personBorder'],
  venn: [...Array.from({ length: 8 }, (_, i) => `venn${i + 1}`), 'vennTitleTextColor', 'vennSetTextColor'],
} as const;

const NESTED_VARIABLES = {
  xyChart: [
    'backgroundColor', 'titleColor', 'dataLabelColor', 'legendTextColor', 'xAxisTitleColor', 'xAxisLabelColor',
    'xAxisTickColor', 'xAxisLineColor', 'yAxisTitleColor', 'yAxisLabelColor', 'yAxisTickColor', 'yAxisLineColor',
  ],
  packet: ['startByteColor', 'endByteColor', 'labelColor', 'titleColor', 'blockStrokeColor', 'blockFillColor'],
  radar: ['axisColor', 'graticuleColor'],
  wardley: ['backgroundColor', 'axisColor', 'axisTextColor', 'gridColor', 'componentFill', 'componentStroke', 'componentLabelColor', 'linkStroke', 'evolutionStroke', 'annotationStroke', 'annotationTextColor', 'annotationFill'],
} as const;

function rgb(value: unknown) {
  expect(typeof value).toBe('string');
  expect(value as string).toMatch(HEX);
  return parseCssColor(value as string)!;
}

function ratio(vars: Record<string, unknown>, a: string, b: string): number {
  return contrastRatio(rgb(vars[a]), rgb(vars[b]));
}

describe('buildMermaidThemeVariables', () => {
  test('sets every documented variable of every family as an opaque hex colour', () => {
    const spec = buildMermaidThemeVariables(PLANNOTATOR_DARK, 'dark');
    expect(spec).not.toBeNull();
    const vars = spec!.themeVariables;
    for (const [family, names] of Object.entries(DOCUMENTED_VARIABLES)) {
      for (const name of names) {
        expect(vars[name], `${family}.${name}`).toMatch(HEX);
      }
    }
    for (const [family, names] of Object.entries(NESTED_VARIABLES)) {
      const nested = vars[family] as Record<string, unknown>;
      expect(nested, family).toBeObject();
      for (const name of names) {
        expect(nested[name], `${family}.${name}`).toMatch(HEX);
      }
    }
    expect((vars.xyChart as { plotColorPalette: string }).plotColorPalette.split(',')).toHaveLength(12);
    expect(vars.darkMode).toBe(true);
    // Nothing handed to Mermaid may still be in a syntax its colour library cannot read.
    const flat = JSON.stringify(vars);
    expect(flat).not.toContain('oklch(');
    expect(flat).not.toContain('var(');
  });

  test('base theme follows the resolved mode; the font follows the sans token', () => {
    const dark = buildMermaidThemeVariables(PLANNOTATOR_DARK, 'dark')!;
    const light = buildMermaidThemeVariables(PLANNOTATOR_LIGHT, 'light')!;
    expect(dark.theme).toBe('dark');
    expect(light.theme).toBe('default');
    expect(light.themeVariables.darkMode).toBe(false);
    expect(dark.themeVariables.fontFamily).toBe(PLANNOTATOR_DARK['font-sans']);
    expect('fontFamily' in light.themeVariables).toBe(false);
    // Node fill is the card token, not a fixed slate, in both modes.
    expect(dark.themeVariables.nodeBkg).toBe(toHex(parseCssColor(PLANNOTATOR_DARK.card)!));
    expect(dark.themeVariables.nodeBkg).not.toBe(MERMAID_CONFIG.themeVariables!.mainBkg);
    expect(light.themeVariables.nodeBkg).toBe('#ffffff');
  });

  test('falls back to the static config when the tokens are absent or unusable', () => {
    expect(buildMermaidThemeVariables(undefined, 'dark')).toBeNull();
    expect(buildMermaidThemeVariables({}, 'dark')).toBeNull();
    expect(buildMermaidThemeVariables({ foreground: '#fff' }, 'dark')).toBeNull();
    expect(buildMermaidThemeVariables({ background: 'var(--x)', foreground: '#fff' }, 'dark')).toBeNull();
    // Identity, not a copy: the fallback IS the pinned static config.
    expect(buildMermaidConfig(null)).toBe(MERMAID_CONFIG);
    const dynamic = buildMermaidConfig(buildMermaidThemeVariables(PLANNOTATOR_DARK, 'dark'));
    expect(dynamic.securityLevel).toBe('strict');
    expect(dynamic.startOnLoad).toBe(false);
    expect(dynamic.flowchart).toEqual(MERMAID_CONFIG.flowchart);
    expect(MERMAID_CONFIG.theme).toBe('dark');
  });

  test('the two required tokens are enough; the rest are derived', () => {
    const spec = buildMermaidThemeVariables({ background: '#ffffff', foreground: '#111111' }, 'light')!;
    expect(spec.themeVariables.nodeBkg).toBe('#ffffff');
    expect(ratio(spec.themeVariables, 'primaryTextColor', 'nodeBkg')).toBeGreaterThanOrEqual(MERMAID_TEXT_CONTRAST_MIN);
    expect(ratio(spec.themeVariables, 'lineColor', 'background')).toBeGreaterThanOrEqual(MERMAID_LINE_CONTRAST_MIN);
  });

  test('an alpha muted-foreground is composited, never passed through with alpha', () => {
    const spec = buildMermaidThemeVariables({ background: '#000000', foreground: '#ffffff', 'muted-foreground': '#ffffff99' }, 'dark')!;
    expect(spec.themeVariables.lineColor).toMatch(HEX);
    // #ffffff99 over black is #999999, a neutral grey; the guard may lift it
    // toward the foreground but never re-introduces alpha or a hue.
    const c = parseCssColor(spec.themeVariables.lineColor as string)!;
    expect(c.r).toBeCloseTo(c.g, 2);
    expect(c.g).toBeCloseTo(c.b, 2);
    expect(c.r).toBeGreaterThanOrEqual(0x99 / 255 - 0.01);
  });
});

describe('contrast guard', () => {
  test('repairs a failing pair by the smallest step toward the ink, and leaves a passing pair alone', () => {
    const white = parseCssColor('#ffffff')!;
    const black = parseCssColor('#000000')!;
    const grey = parseCssColor('#cccccc')!;
    const untouched = ensureContrast(black, white, 4.5, [black, white]);
    expect(untouched).toEqual({ ...black, a: 1 });
    const repaired = ensureContrast(grey, white, 4.5, [black, white]);
    const r = contrastRatio(repaired, white);
    expect(r).toBeGreaterThanOrEqual(4.5);
    // Smallest step: not slammed all the way to the ink.
    expect(r).toBeLessThan(6);
    // First ink cannot reach the ratio (white on white): falls through to the second.
    const flipped = ensureContrast(grey, white, 4.5, [white, black]);
    expect(contrastRatio(flipped, white)).toBeGreaterThanOrEqual(4.5);
  });

  test('a palette whose muted-foreground hugs the background still draws readable edges and labels', () => {
    const tokens: MermaidThemeTokens = {
      background: '#202020',
      foreground: '#e0e0e0',
      card: '#242424',
      'card-foreground': '#2a2a2a', // deliberately unreadable on the card
      'muted-foreground': '#303030', // deliberately invisible on the page
      border: '#212121',
    };
    const vars = buildMermaidThemeVariables(tokens, 'dark')!.themeVariables;
    expect(ratio(vars, 'lineColor', 'background')).toBeGreaterThanOrEqual(MERMAID_LINE_CONTRAST_MIN);
    expect(ratio(vars, 'primaryTextColor', 'nodeBkg')).toBeGreaterThanOrEqual(MERMAID_TEXT_CONTRAST_MIN);
    expect(ratio(vars, 'nodeBorder', 'background')).toBeGreaterThanOrEqual(1.5);
  });

  const TEXT_PAIRS: Array<[string, string]> = [
    ['primaryTextColor', 'nodeBkg'],
    ['nodeTextColor', 'nodeBkg'],
    ['textColor', 'background'],
    ['titleColor', 'background'],
    ['actorTextColor', 'actorBkg'],
    ['signalTextColor', 'background'],
    ['labelTextColor', 'labelBoxBkgColor'],
    ['loopTextColor', 'labelBoxBkgColor'],
    ['noteTextColor', 'noteBkgColor'],
    ['sequenceNumberColor', 'lineColor'],
    ['stateLabelColor', 'stateBkg'],
    ['transitionLabelColor', 'background'],
    ['classText', 'nodeBkg'],
    ['requirementTextColor', 'requirementBackground'],
    ['relationLabelColor', 'relationLabelBackground'],
    ['commitLabelColor', 'commitLabelBackground'],
    ['tagLabelColor', 'tagLabelBackground'],
    ['taskTextColor', 'taskBkgColor'],
    // Mermaid paints the label INSIDE a done, active or critical bar with
    // taskTextDarkColor (`.doneText0`, `.activeText0`, `.critText0` …).
    ['taskTextDarkColor', 'doneTaskBkgColor'],
    ['taskTextDarkColor', 'activeTaskBkgColor'],
    ['taskTextDarkColor', 'critBkgColor'],
    ['taskTextOutsideColor', 'background'],
    ['pieLegendTextColor', 'background'],
    ['pieTitleTextColor', 'background'],
    ['pieSectionTextColor', 'pie1'],
    ['errorTextColor', 'errorBkgColor'],
    ['quadrant1TextFill', 'quadrant1Fill'],
    ['quadrant2TextFill', 'quadrant2Fill'],
    ...Array.from({ length: 12 }, (_, i) => [`cScaleLabel${i}`, `cScale${i}`] as [string, string]),
    ...Array.from({ length: 8 }, (_, i) => [`gitBranchLabel${i}`, `git${i}`] as [string, string]),
  ];
  const LINE_PAIRS: Array<[string, string]> = [
    ['lineColor', 'background'],
    ['arrowheadColor', 'background'],
    ['defaultLinkColor', 'background'],
    ['signalColor', 'background'],
    ['actorLineColor', 'background'],
    ['transitionColor', 'background'],
    ['relationColor', 'background'],
    ['activeTaskBorderColor', 'background'],
    ['todayLineColor', 'background'],
    ['critBorderColor', 'background'],
    ...Array.from({ length: 8 }, (_, i) => [`git${i}`, 'background'] as [string, string]),
  ];

  /**
   * A gantt label too wide for its bar is drawn beside it, on the page. The
   * class lists are the ones Mermaid 12 writes on such a label, per task kind.
   * Mermaid's own sheet paints active and active-critical text (inside OR
   * outside the bar) with `taskTextDarkColor !important`; plain, done and
   * done-critical outside labels get `taskTextOutsideColor`; a vertical
   * marker's label (`vertText`, always beside its zero-width bar) gets
   * `vertLineColor !important`, about 3:1 on the page. A `themeCSS` rule with
   * `fill: … !important` whose selector matches the label wins over all of
   * them (it is more specific or later, and the guard only counts a rule it
   * can match). Every outside label, the marker's included on purpose, is
   * drawn in the page's text colour.
   */
  const OUTSIDE_LABELS: Array<{ kind: string; classes: string[]; mermaidFill: string }> = [
    { kind: 'plain', classes: ['taskTextOutsideRight', 'taskTextOutside1'], mermaidFill: 'taskTextOutsideColor' },
    { kind: 'done', classes: ['taskTextOutsideRight', 'taskTextOutside1', 'doneText1'], mermaidFill: 'taskTextOutsideColor' },
    { kind: 'crit', classes: ['taskTextOutsideRight', 'taskTextOutside1', 'critText1'], mermaidFill: 'taskTextOutsideColor' },
    { kind: 'done crit', classes: ['taskTextOutsideLeft', 'taskTextOutside0', 'doneCritText0'], mermaidFill: 'taskTextOutsideColor' },
    { kind: 'active', classes: ['taskTextOutsideRight', 'taskTextOutside1', 'activeText1'], mermaidFill: 'taskTextDarkColor' },
    { kind: 'active (left)', classes: ['taskTextOutsideLeft', 'taskTextOutside0', 'activeText0'], mermaidFill: 'taskTextDarkColor' },
    { kind: 'crit active', classes: ['taskTextOutsideRight', 'taskTextOutside1', 'activeCritText1', 'critText1'], mermaidFill: 'taskTextDarkColor' },
    { kind: 'active milestone', classes: ['taskTextOutsideRight', 'taskTextOutside0', 'activeText0', 'milestoneText'], mermaidFill: 'taskTextDarkColor' },
    { kind: 'vertical marker', classes: ['taskTextOutsideRight', 'taskTextOutside0', 'vertText'], mermaidFill: 'vertLineColor' },
  ];

  /** A done bar must not read as a plain, active or critical one (OKLab distance). */
  const DONE_BAR_MIN_DELTA_E = 0.1;
  function deltaE(a: RgbColor, b: RgbColor): number {
    const x = rgbToOklab(a);
    const y = rgbToOklab(b);
    return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
  }

  /** The `fill … !important` of the last themeCSS rule whose selector (class compounds, `:not(.x)`) matches `classes`. */
  function themeCssFill(themeCSS: string | undefined, classes: string[]): string | null {
    let found: string | null = null;
    for (const rule of (themeCSS ?? '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const fill = /fill\s*:\s*(#[0-9a-f]{6})\s*!important/i.exec(rule[2]!)?.[1];
      if (!fill) continue;
      const matches = rule[1]!.split(',').some((selector) => {
        const sel = selector.trim();
        const excluded = [...sel.matchAll(/:not\(\.([\w-]+)\)/g)].map((m) => m[1]!);
        const required = [...sel.replace(/:not\([^)]*\)/g, '').matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
        return required.length > 0 && required.every((c) => classes.includes(c)) && !excluded.some((c) => classes.includes(c));
      });
      if (matches) found = fill;
    }
    return found;
  }

  for (const file of themeFiles) {
    const css = readFileSync(join(themesDir, file), 'utf8');
    const id = file.replace(/\.css$/, '');
    for (const mode of ['dark', 'light'] as MermaidThemeMode[]) {
      const selector = mode === 'dark' ? `.theme-${id}` : `.theme-${id}.light`;
      const tokens = tokensFromCss(css, selector);
      test(`${id} / ${mode}: a gantt label outside its bar, of every task kind, >= ${MERMAID_TEXT_CONTRAST_MIN}:1 on the page`, () => {
        const config = buildMermaidConfig(buildMermaidThemeVariables(tokens, mode));
        const vars = config.themeVariables as Record<string, unknown>;
        const failures: string[] = [];
        for (const label of OUTSIDE_LABELS) {
          const fill = themeCssFill(config.themeCSS, label.classes) ?? (vars[label.mermaidFill] as string);
          const r = contrastRatio(rgb(fill), rgb(vars.background));
          if (r < MERMAID_TEXT_CONTRAST_MIN) failures.push(`${label.kind} outside label on background: ${r.toFixed(2)}`);
          if (fill !== vars.taskTextOutsideColor) failures.push(`${label.kind} outside label is ${fill}, not the page text ${vars.taskTextOutsideColor}`);
        }
        expect(failures).toEqual([]);
      });
      test(`${id} / ${mode}: a done gantt bar is distinct from plain, active and critical bars (OKLab dE >= ${DONE_BAR_MIN_DELTA_E}) and stands off the page`, () => {
        const vars = buildMermaidThemeVariables(tokens, mode)!.themeVariables;
        const failures: string[] = [];
        for (const other of ['taskBkgColor', 'activeTaskBkgColor', 'critBkgColor']) {
          const d = deltaE(rgb(vars.doneTaskBkgColor), rgb(vars[other]));
          if (d < DONE_BAR_MIN_DELTA_E) failures.push(`doneTaskBkgColor ${vars.doneTaskBkgColor} vs ${other} ${vars[other]}: dE ${d.toFixed(3)}`);
        }
        const page = ratio(vars, 'doneTaskBkgColor', 'background');
        if (page < MERMAID_LINE_CONTRAST_MIN) failures.push(`doneTaskBkgColor on background: ${page.toFixed(2)}`);
        expect(failures).toEqual([]);
      });
      test(`${id} / ${mode}: every text pair >= ${MERMAID_TEXT_CONTRAST_MIN}:1, every line pair >= ${MERMAID_LINE_CONTRAST_MIN}:1`, () => {
        expect(tokens, `${selector} block in ${file}`).toBeDefined();
        const spec = buildMermaidThemeVariables(tokens, mode);
        expect(spec).not.toBeNull();
        const vars = spec!.themeVariables;
        const failures: string[] = [];
        for (const [text, fill] of TEXT_PAIRS) {
          const r = ratio(vars, text, fill);
          if (r < MERMAID_TEXT_CONTRAST_MIN) failures.push(`${text} on ${fill}: ${r.toFixed(2)}`);
        }
        for (const [stroke, canvas] of LINE_PAIRS) {
          const r = ratio(vars, stroke, canvas);
          if (r < MERMAID_LINE_CONTRAST_MIN) failures.push(`${stroke} vs ${canvas}: ${r.toFixed(2)}`);
        }
        expect(failures).toEqual([]);
        // The categorical scale is twelve distinct fills.
        const scale = new Set(Array.from({ length: 12 }, (_, i) => vars[`cScale${i}`]));
        expect(scale.size).toBe(12);
      });
    }
  }
});

/**
 * Label wrap width (#2064). Mermaid 12 wraps node labels at 120 px (11 used
 * 200), which at Plannotator's 16 px labels splits about eight CJK characters
 * and short Latin labels. 140 is an owner-approved value, pinned on purpose.
 *
 * What regresses if these fail: one of the two `initialize` paths (the static
 * config the lazy loader and a host without theme tokens use, or the themed
 * config `applyMermaidTheme` passes) loses the width and labels wrap at
 * Mermaid's default again.
 */
describe('label wrap width', () => {
  test('the owner-approved width is 140 px', () => {
    expect(MERMAID_LABEL_WRAP_WIDTH).toBe(140);
  });

  test('the static (host fallback) config wraps flowchart and state labels at it', () => {
    expect(MERMAID_CONFIG.flowchart?.wrappingWidth).toBe(140);
    expect(MERMAID_CONFIG.state?.wrappingWidth).toBe(140);
  });

  test('the themed config keeps it in both modes', () => {
    for (const [tokens, mode] of [[PLANNOTATOR_DARK, 'dark'], [PLANNOTATOR_LIGHT, 'light']] as const) {
      const themed = buildMermaidConfig(buildMermaidThemeVariables(tokens, mode));
      expect(themed.flowchart?.wrappingWidth).toBe(140);
      expect(themed.state?.wrappingWidth).toBe(140);
    }
  });
});

describe('applyMermaidTheme', () => {
  function fakeRuntime() {
    const calls: unknown[] = [];
    return { calls, initialize: (config: unknown) => { calls.push(config); } };
  }

  test('without theme tokens it never re-initializes a fresh runtime (host fallback contract)', () => {
    __resetMermaidThemeForTests();
    try {
      const runtime = fakeRuntime();
      // No tokens are defined in this process (no DOM, or a DOM without theme.css).
      expect(applyMermaidTheme(runtime, mermaidThemeKey('plannotator', 'dark'))).toBe('static');
      expect(applyMermaidTheme(runtime, mermaidThemeKey('plannotator', 'dark'))).toBe('unchanged');
      expect(applyMermaidTheme(runtime, mermaidThemeKey('github', 'light'))).toBe('static');
      expect(runtime.calls).toEqual([]);
    } finally {
      __resetMermaidThemeForTests();
    }
  });

  test('a new runtime object is themed afresh even under the same key', () => {
    __resetMermaidThemeForTests();
    try {
      const first = fakeRuntime();
      const second = fakeRuntime();
      const key = mermaidThemeKey('plannotator', 'dark');
      expect(applyMermaidTheme(first, key)).toBe('static');
      expect(applyMermaidTheme(second, key)).toBe('static');
      expect(applyMermaidTheme(second, key)).toBe('unchanged');
    } finally {
      __resetMermaidThemeForTests();
    }
  });
});

/**
 * Node drop shadow (the `dropShadow` theme variable).
 *
 * What regresses if these fail:
 * - the shipped look changes: Mermaid 12's neo shadow comes back at full
 *   strength (the grey halo), or disappears entirely;
 * - the shadow is derived in the wrong polarity, which on a dark page paints a
 *   black shadow on a near-black ground — a valid filter that renders nothing,
 *   the exact bug the lab found;
 * - a shadow amount stops reaching the runtime because the cache key ignores
 *   it, so the setting silently does nothing until the palette changes;
 * - the shadow leaks into a fill or a label colour (it is a paint-time filter
 *   and must touch nothing else).
 */
describe('node shadow', () => {
  /** The `rgba(r, g, b, a)` inside a `drop-shadow(x y blur rgba(...))`. */
  function shadowColor(filter: string): { color: RgbColor; alpha: number } {
    const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/u.exec(filter);
    if (!m) throw new Error(`no rgba in ${filter}`);
    return {
      color: { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255, a: 1 },
      alpha: Number(m[4]),
    };
  }

  test('the setting scale and the mapping amount are the same number', () => {
    expect(DEFAULT_DIAGRAM_SHADOW / 100).toBe(DEFAULT_MERMAID_SHADOW_AMOUNT);
    expect(DIAGRAM_SHADOW_OPTIONS).toContain(DEFAULT_DIAGRAM_SHADOW);
  });

  test('amount 1 reproduces Mermaid 12 own geometry, 0.7 is the shipped toning', () => {
    const ground = parseCssColor('#111318')!;
    expect(buildMermaidShadow(ground, 1)).toStartWith('drop-shadow(1px 2px 2px ');
    expect(buildMermaidShadow(ground, 0.7)).toStartWith('drop-shadow(0.79px 1.58px 1.58px ');
    expect(buildMermaidShadow(ground, 0)).toBe(false);
    // Out of range is clamped, not trusted.
    expect(buildMermaidShadow(ground, 4)).toBe(buildMermaidShadow(ground, 1));
    expect(buildMermaidShadow(ground, -1)).toBe(false);
  });

  test('a ground the palette could not produce falls back to Mermaid own colour', () => {
    expect(buildMermaidShadow(undefined, 0.7)).toContain('rgba(185, 185, 185, 1)');
  });

  test('amount 0 publishes no shadow at all, including the state dots', () => {
    const spec = buildMermaidThemeVariables(PLANNOTATOR_DARK, 'dark', { shadowAmount: 0 })!;
    expect(spec.themeVariables.dropShadow).toBe(false);
    expect(spec.themeVariables.nodeShadow).toBe(false);
    expect(spec.shadowAmount).toBe(0);
  });

  /**
   * Fill / label fingerprint: every variable the mapping produces EXCEPT the
   * two shadow keys, at amount 0 against the shipped 70. The shadow is a
   * paint-time filter; if a change to it ever moved a fill or a label colour,
   * this is what catches it.
   */
  const fingerprint = (vars: Record<string, unknown>) =>
    Object.entries(vars)
      .filter(([k]) => k !== 'dropShadow' && k !== 'nodeShadow')
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .sort()
      .join('\n');

  test('the shadow touches nothing but the shadow', () => {
    for (const [tokens, mode] of [
      [PLANNOTATOR_DARK, 'dark'],
      [PLANNOTATOR_LIGHT, 'light'],
    ] as Array<[MermaidThemeTokens, MermaidThemeMode]>) {
      const off = buildMermaidThemeVariables(tokens, mode, { shadowAmount: 0 })!.themeVariables;
      const on = buildMermaidThemeVariables(tokens, mode)!.themeVariables;
      expect(fingerprint(on)).toBe(fingerprint(off));
    }
  });

  test('the cache key carries the amount, and the default key is the old (palette, mode) key', () => {
    expect(mermaidThemeKey('plannotator', 'dark')).toBe('dark:plannotator');
    expect(mermaidThemeKey('plannotator', 'dark', DEFAULT_MERMAID_SHADOW_AMOUNT)).toBe('dark:plannotator');
    expect(mermaidThemeKey('plannotator', 'dark', 0)).not.toBe('dark:plannotator');
    expect(mermaidThemeKey('plannotator', 'dark', 0)).not.toBe(mermaidThemeKey('plannotator', 'dark', 0.4));
    expect(shadowAmountFromKey(mermaidThemeKey('plannotator', 'dark', 0.4))).toBe(0.4);
    expect(shadowAmountFromKey(mermaidThemeKey('plannotator', 'dark'))).toBe(DEFAULT_MERMAID_SHADOW_AMOUNT);
    // A palette id is never mistaken for an amount.
    expect(shadowAmountFromKey('light:one-light')).toBe(DEFAULT_MERMAID_SHADOW_AMOUNT);
  });

  /** Every shipped palette, both modes: a shadow at the default, in the direction that reads. */
  for (const file of themeFiles) {
    const css = readFileSync(join(themesDir, file), 'utf8');
    const id = file.replace(/\.css$/, '');
    for (const mode of ['dark', 'light'] as MermaidThemeMode[]) {
      const selector = mode === 'dark' ? `.theme-${id}` : `.theme-${id}.light`;
      const tokens = tokensFromCss(css, selector);
      test(`${id} / ${mode}: a default shadow that differs from the ground in the readable direction`, () => {
        expect(tokens, `${selector} block in ${file}`).toBeDefined();
        const spec = buildMermaidThemeVariables(tokens, mode)!;
        expect(spec.shadowAmount).toBe(DEFAULT_MERMAID_SHADOW_AMOUNT);
        const filter = spec.themeVariables.dropShadow;
        expect(typeof filter).toBe('string');
        expect(filter as string).toStartWith('drop-shadow(0.79px 1.58px 1.58px ');
        const ground = compositeOver(parseCssColor(tokens!.background!)!, { r: 1, g: 1, b: 1, a: 1 });
        const { color, alpha } = shadowColor(filter as string);
        const groundL = relativeLuminance(ground);
        if (isDarkBackground(ground)) {
          // A shadow on a dark page LIFTS: darker than the ground is invisible.
          expect(relativeLuminance(color)).toBeGreaterThan(groundL);
          expect(alpha).toBeCloseTo(0.684, 3);
        } else {
          expect(relativeLuminance(color)).toBeLessThan(groundL);
          expect(alpha).toBeCloseTo(0.46, 3);
        }
        // Never Mermaid's fixed grey: the tint comes from the palette.
        expect(filter as string).not.toContain('185, 185, 185');
        // Fills and labels are identical with the shadow off: paint only.
        const off = buildMermaidThemeVariables(tokens, mode, { shadowAmount: 0 })!.themeVariables;
        expect(fingerprint(spec.themeVariables)).toBe(fingerprint(off));
      });
    }
  }
});
