// An author's colours under Pele (`peleAuthorTheme.ts`): only the colours a
// source spells out. What regresses: a theme name (forest, dark) recolours a
// diagram away from the person's theme, a typed colour is lost, an author's
// line or text colour vanishes on the person's page, text in a filled shape
// stops reading on that fill, a background panel is painted, or a value that
// could fetch or reach a variable gets into the drawing.
import { describe, expect, test } from 'bun:test';
import { contrastRatio, parseCssColor } from './cssColor';
import { peleAuthorColors, readPeleAuthorColors } from './peleAuthorTheme';
import { PELE_LINE_MIN, PELE_TEXT_MIN } from './peleTheme';

const light = { '--pele-bg': '#ffffff', '--pele-fg': '#1f2328', '--pele-muted': '#59636e', '--pele-line': '#59636e', '--pele-surface': '#f6f8fa', '--pele-surface-alt': '#eaeef2', '--pele-border': '#d1d9e0', '--pele-font': 'Inter' } as const;
const dark = { '--pele-bg': '#161b22', '--pele-fg': '#e6edf3', '--pele-muted': '#9198a1', '--pele-line': '#9198a1', '--pele-surface': '#21262d', '--pele-surface-alt': '#2d333b', '--pele-border': '#3d444d', '--pele-font': 'Inter' } as const;
const contrast = (a: string | undefined, b: string | undefined): number => contrastRatio(parseCssColor(a)!, parseCssColor(b)!);
const BASE = '---\nconfig:\n  theme: base\n  themeVariables:\n    primaryColor: "#ffd6e8"\n    lineColor: "#7a1f4f"\n    primaryTextColor: "#3d0a24"\n---\nflowchart LR\n  A[Charlie Dunn] --> B[Ada Novak]';

describe('a theme name is ignored', () => {
  test('forest, dark, neutral, default and base alone change nothing: the person\'s theme, as with no directive', () => {
    for (const name of ['forest', 'dark', 'neutral', 'default', 'base', 'midnight']) {
      expect(peleAuthorColors(`%%{init: {'theme': '${name}'}}%%\nflowchart LR\n  A --> B`, light)).toBeNull();
      expect(peleAuthorColors(`---\nconfig:\n  theme: ${name}\n---\nflowchart LR\n  A --> B`, dark)).toBeNull();
    }
    expect(peleAuthorColors('flowchart LR\n  A --> B', light)).toBeNull();
  });
});

describe('the colours an author spells out', () => {
  test('are applied over the person\'s palette, with or without theme: base, from a directive or front matter', () => {
    const viaBase = peleAuthorColors(BASE, light)!;
    expect(viaBase.vars['--pele-surface']).toBe('#ffd6e8');
    expect(viaBase.vars['--pele-line']).toBe('#7a1f4f');
    expect(viaBase.vars['--pele-fg']).toBe('#3d0a24');
    expect(viaBase.vars['--pele-surface-alt']).toBe(light['--pele-surface-alt']);
    expect(viaBase.vars['--pele-font']).toBe('Inter');
    const viaForest = peleAuthorColors("%%{init: {'theme': 'forest', 'themeVariables': {'primaryColor': '#ffd6e8'}}}%%\nflowchart LR\n  A", light)!;
    expect(viaForest.vars['--pele-surface']).toBe('#ffd6e8');
    // Nothing from forest itself: everything not typed is the person's.
    expect(viaForest.vars['--pele-line']).toBe(light['--pele-line']);
    expect(viaForest.vars['--pele-border']).toBe(light['--pele-border']);
  });

  test("an author background is never painted: the ground stays the person's", () => {
    const colors = peleAuthorColors("%%{init: {'themeVariables': {'background': '#000000', 'primaryColor': '#ffd6e8'}}}%%\nflowchart LR\n  A", light)!;
    expect(colors.vars['--pele-bg']).toBe(light['--pele-bg']);
    expect(peleAuthorColors("%%{init: {'themeVariables': {'background': '#000000'}}}%%\nflowchart LR\n  A", light)).toBeNull();
  });

  test('values that are not safe colours are ignored, and so are themeCSS and unknown keys', () => {
    const source =
      "%%{init: {'theme': 'base', 'themeCSS': '.node rect { fill: url(https://x) }', 'themeVariables': {'primaryColor': 'url(https://x/y.png)', 'lineColor': 'var(--secret)', 'primaryTextColor': 'red; background-image: url(x)', 'mainBkg': '#00ff00', 'fontFamily': 'Comic Sans', 'noSuchKey': '#123456'}}}%%\nflowchart LR\n  A";
    expect(readPeleAuthorColors(source)).toEqual({ mainBkg: '#00ff00', noSuchKey: '#123456' });
    const colors = peleAuthorColors(source, light)!;
    expect(colors.vars['--pele-surface']).toBe('#00ff00');
    expect(colors.vars['--pele-line']).toBe(light['--pele-line']);
    expect(colors.vars['--pele-fg']).toBe(light['--pele-fg']);
    expect(Object.values(colors.vars).join(' ')).not.toMatch(/url\(|var\(|;|123456/u);
  });
});

describe('readability on the person\'s page', () => {
  test('a line colour that does not read on the page gives way to the person\'s line; one that reads is kept', () => {
    const onDark = peleAuthorColors(BASE, dark)!;
    expect(contrast('#7a1f4f', dark['--pele-bg'])).toBeLessThan(PELE_LINE_MIN);
    expect(onDark.vars['--pele-line']).toBe(dark['--pele-line']);
    expect(onDark.fellBack).toContain('line');
    const onLight = peleAuthorColors(BASE, light)!;
    expect(onLight.vars['--pele-line']).toBe('#7a1f4f');
    expect(onLight.fellBack).not.toContain('line');
  });

  test('text drawn on the page gives way, but text in the author-filled node keeps the author\'s colour where it reads', () => {
    const colors = peleAuthorColors(BASE, dark)!;
    // #3d0a24 on the dark page does not read: edge and message labels take the person's text colour.
    expect(colors.vars['--pele-fg']).toBe(dark['--pele-fg']);
    expect(colors.fellBack).toContain('text');
    // On the pink node it does.
    expect(colors.rules).toContainEqual({ selector: 'g.pele-node text', property: 'fill', value: '#3d0a24' });
  });

  test('with no author text colour, text in an author-filled node is the better of the person\'s text and ground colours', () => {
    const colors = peleAuthorColors("%%{init: {'themeVariables': {'primaryColor': '#ffd6e8'}}}%%\nflowchart LR\n  A", dark)!;
    const rule = colors.rules.find((r) => r.selector === 'g.pele-node text');
    // The person's light text would not read on pink; their dark ground does.
    expect(rule?.value).toBe(dark['--pele-bg']);
    expect(contrast(rule?.value, '#ffd6e8')).toBeGreaterThanOrEqual(PELE_TEXT_MIN);
  });

  test("lifelines (drawn on the page in the border colour) give way; node outlines keep the author's border", () => {
    const colors = peleAuthorColors("%%{init: {'themeVariables': {'primaryBorderColor': '#20262e'}}}%%\nsequenceDiagram\n  A->>B: hi", dark)!;
    expect(colors.vars['--pele-border']).toBe('#20262e');
    expect(colors.rules).toContainEqual({ selector: '.pele-lifelines', property: 'stroke', value: dark['--pele-border'] });
  });

  test('with no palette on the page, the typed colours apply as given', () => {
    const colors = peleAuthorColors(BASE, null)!;
    expect(colors.vars['--pele-line']).toBe('#7a1f4f');
    expect(colors.fellBack).toEqual([]);
  });
});
