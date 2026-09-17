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
import { MERMAID_CONFIG } from './mermaid';
import { contrastRatio, parseCssColor, toHex } from './cssColor';
import {
  MERMAID_LINE_CONTRAST_MIN,
  MERMAID_TEXT_CONTRAST_MIN,
  __resetMermaidThemeForTests,
  applyMermaidTheme,
  buildMermaidConfig,
  buildMermaidThemeVariables,
  ensureContrast,
  mermaidThemeKey,
  type MermaidThemeMode,
  type MermaidThemeTokens,
} from './mermaidTheme';

const HEX = /^#[0-9a-f]{6}$/;

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

  /**
   * Every shipped palette, both modes. Reads the tokens straight out of the
   * CSS so a palette added later is swept automatically.
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

  for (const file of themeFiles) {
    const css = readFileSync(join(themesDir, file), 'utf8');
    const id = file.replace(/\.css$/, '');
    for (const mode of ['dark', 'light'] as MermaidThemeMode[]) {
      const selector = mode === 'dark' ? `.theme-${id}` : `.theme-${id}.light`;
      const tokens = tokensFromCss(css, selector);
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
