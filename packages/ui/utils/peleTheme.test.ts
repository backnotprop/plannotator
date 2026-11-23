/**
 * The Pele theme adapter's contrast guard, over every shipped palette in both
 * modes, measured on the variables Pele receives (no render needed: Pele
 * paints exactly these colours). The pairs are the ones Pele draws:
 *   - text (`--pele-fg`) and secondary text (`--pele-muted`) on the canvas
 *     (`--pele-bg`), node fills (`--pele-surface`) and cluster fills
 *     (`--pele-surface-alt`);
 *   - the canvas colour used as ink on coloured fills: the accent, the
 *     critical fill and the eight series fills (pie slices, git branches,
 *     mindmap sections, gantt bars);
 *   - lines (`--pele-line`) on the canvas and both fills;
 *   - node borders (`--pele-border`) on the canvas.
 * Thresholds are the Mermaid guard's: text 4.5:1 and lines 3:1 plus its 0.1
 * headroom, borders 1.5:1.
 *
 * What regresses if this fails: a palette in which some Pele label, line or
 * outline is hard to read.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio, parseCssColor, type RgbColor } from './cssColor';
import { buildMermaidShadow, buildMermaidThemeVariables, type MermaidThemeMode, type MermaidThemeTokens } from './mermaidTheme';
import { buildPeleThemeVariables, peleShadowCss, PELE_BORDER_MIN, PELE_LINE_MIN, PELE_SERIES_COUNT, PELE_TEXT_MIN, type PeleThemeVariables } from './peleTheme';

const themesDir = join(import.meta.dir, '..', 'themes');
const themeFiles = readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort();

function tokensFromCss(css: string, selector: string): MermaidThemeTokens | undefined {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = (rule[1] ?? '').split(',').map((sel) => sel.trim());
    if (!selectors.includes(selector)) continue;
    const tokens: Record<string, string> = {};
    for (const m of (rule[2] ?? '').matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)) tokens[m[1] as string] = (m[2] as string).trim();
    return tokens as MermaidThemeTokens;
  }
  return undefined;
}

const SURFACES = ['--pele-bg', '--pele-surface', '--pele-surface-alt'] as const;
const INKED_FILLS = ['--pele-accent', '--pele-critical', ...Array.from({ length: PELE_SERIES_COUNT }, (_, i) => `--pele-series-${i + 1}`)];

function failures(vars: PeleThemeVariables): string[] {
  const color = (name: string): RgbColor => {
    const value = (vars as Record<string, string>)[name];
    const parsed = parseCssColor(value);
    if (parsed === undefined) throw new Error(`${name} is not a colour: ${value}`);
    return parsed;
  };
  const out: string[] = [];
  const check = (a: string, b: string, min: number) => {
    const r = contrastRatio(color(a), color(b));
    if (r < min) out.push(`${a} on ${b}: ${r.toFixed(2)} < ${min}`);
  };
  for (const surface of SURFACES) {
    check('--pele-fg', surface, PELE_TEXT_MIN);
    check('--pele-muted', surface, PELE_TEXT_MIN);
    check('--pele-line', surface, PELE_LINE_MIN);
  }
  for (const fill of INKED_FILLS) check('--pele-bg', fill, PELE_TEXT_MIN);
  check('--pele-border', '--pele-bg', PELE_BORDER_MIN);
  return out;
}

describe('Pele theme adapter', () => {
  test('every palette the app ships (theme.css imports) is swept', () => {
    // The list is the stylesheet's own, so a new palette needs no edit here (a fixed count broke when main added two).
    const shipped = Array.from(readFileSync(join(themesDir, '..', 'theme.css'), 'utf8').matchAll(/@import\s+"\.\/themes\/([\w-]+\.css)"/gu), (m) => m[1] as string).sort();
    expect(shipped.length).toBeGreaterThan(0);
    expect(themeFiles).toEqual(expect.arrayContaining(shipped));
  });

  for (const file of themeFiles) {
    const id = file.replace(/\.css$/, '');
    const css = readFileSync(join(themesDir, file), 'utf8');
    for (const mode of ['dark', 'light'] as MermaidThemeMode[]) {
      const selector = mode === 'dark' ? `.theme-${id}` : `.theme-${id}.light`;
      test(`${id} / ${mode}: text ${PELE_TEXT_MIN}:1 on every surface and coloured fill, lines ${PELE_LINE_MIN}:1, borders ${PELE_BORDER_MIN}:1`, () => {
        const vars = buildPeleThemeVariables(tokensFromCss(css, selector), mode);
        expect(vars).not.toBeNull();
        expect(failures(vars!)).toEqual([]);
        // The eight series stay eight colours a reader can tell apart.
        expect(new Set(Array.from({ length: PELE_SERIES_COUNT }, (_, i) => vars![`--pele-series-${i + 1}`])).size).toBe(PELE_SERIES_COUNT);
      });
    }
  }

  test('the adapter hands Pele the colours the Mermaid mapping already guards', () => {
    const tokens = tokensFromCss(readFileSync(join(themesDir, 'plannotator.css'), 'utf8'), '.theme-plannotator')!;
    const vars = buildPeleThemeVariables(tokens, 'dark')!;
    expect(vars['--pele-fg']).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars['--pele-font']).toBe(tokens['font-sans']);
  });

  test('no tokens: no variables, so Pele keeps its own colours', () => {
    expect(buildPeleThemeVariables(undefined, 'dark')).toBeNull();
  });
});

// The Diagram Shadow setting under Pele. What regresses: the setting does
// nothing under Pele, its shadow is not the one Mermaid's nodes get in the same
// palette and mode, it stays on when the setting is off, or the rule reaches
// past the one svg.
describe('the node shadow under Pele', () => {
  const svg = (cls: string) => ({ getAttribute: (name: string) => (name === 'id' ? 'plannotator-pele-r1' : name === 'class' ? cls : null) }) as unknown as Element;
  const css = readFileSync(join(themesDir, 'plannotator.css'), 'utf8');

  test("one rule, scoped under the svg's id, on nodes, clusters and notes, with Mermaid's value for the palette and mode", () => {
    for (const mode of ['dark', 'light'] as MermaidThemeMode[]) {
      const tokens = tokensFromCss(css, mode === 'dark' ? '.theme-plannotator' : '.theme-plannotator.light')!;
      const rule = peleShadowCss(svg('pele pele-flowchart'), mode, 0.7, tokens)!;
      const mermaid = buildMermaidThemeVariables(tokens, mode, { shadowAmount: 0.7 })!.themeVariables.dropShadow as string;
      expect(rule).toBe(
        `#plannotator-pele-r1 g.pele-node > :first-child, #plannotator-pele-r1 g.pele-cluster > rect:first-child, #plannotator-pele-r1 g.pele-note > :first-child { filter: ${mermaid}; }`,
      );
    }
    const dark = peleShadowCss(svg('pele pele-flowchart'), 'dark', 1, tokensFromCss(css, '.theme-plannotator'));
    const light = peleShadowCss(svg('pele pele-flowchart'), 'light', 1, tokensFromCss(css, '.theme-plannotator.light'));
    expect(dark).not.toBe(light);
  });

  test('off when the setting is off, and never on a mindmap or gantt chart (Mermaid draws them without one)', () => {
    expect(peleShadowCss(svg('pele pele-flowchart'), 'light', 0, undefined)).toBeNull();
    expect(peleShadowCss(svg('pele pele-mindmap'), 'light', 1, undefined)).toBeNull();
    expect(peleShadowCss(svg('pele pele-gantt'), 'light', 1, undefined)).toBeNull();
  });

  test('a host without the theme tokens gets the default amount in Mermaid\'s own grey', () => {
    expect(peleShadowCss(svg('pele pele-sequence'), 'light', undefined, undefined)).toContain(`filter: ${buildMermaidShadow(undefined, 0.7)};`);
  });
});
