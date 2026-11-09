/**
 * The "All changes" row's +/- counts must read at 4.5:1 on every surface the
 * row is drawn on (the sidebar, the selected row, the hovered row), in every
 * palette that ships, light and dark. Swept from the CSS itself, so a palette
 * added later is checked too.
 *
 * Failures caught: the counts falling back under 4.5:1 (they were the
 * palette's success/destructive at 60% opacity, under 2:1 in several
 * palettes); a fix that reaches 4.5:1 by greying them (moving toward the
 * foreground turned + and - into the same grey in about 20 palettes).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio, hueDistance, parseCssColor, rgbToOklch } from '@plannotator/ui/utils/cssColor';
import { DIFF_COUNT_CONTRAST_MIN, diffCountColors, diffCountSurfaces, type DiffCountTokens } from './diffCountColors';

const themesDir = join(import.meta.dir, '..', '..', 'ui', 'themes');
const themeFiles = readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort();

const isGreenish = (H: number) => H >= 90 && H <= 200;
const isReddish = (H: number) => H >= 330 || H <= 70;
/** OKLCH of a colour token, or of a result hex. */
const lch = (value: string) => rgbToOklch(parseCssColor(value)!);

/** First rule whose selector list names `selector` (some files write `.theme-x,\n.theme-x.light {`). */
function tokensFromCss(css: string, selector: string): DiffCountTokens | undefined {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = rule[1].split(',').map((sel) => sel.trim());
    if (!selectors.includes(selector)) continue;
    const tokens: Record<string, string> = {};
    for (const m of rule[2].matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
    return tokens as DiffCountTokens;
  }
  return undefined;
}

describe('All changes row counts', () => {
  test('there are palettes to sweep', () => {
    expect(themeFiles.length).toBeGreaterThan(30);
  });

  for (const file of themeFiles) {
    const id = file.replace(/\.css$/, '');
    const css = readFileSync(join(themesDir, file), 'utf8');
    for (const mode of ['dark', 'light'] as const) {
      const selector = mode === 'dark' ? `.theme-${id}` : `.theme-${id}.light`;
      const tokens = tokensFromCss(css, selector);
      if (!tokens) continue; // a palette with one mode
      test(`${id} / ${mode}: + and - read at ${DIFF_COUNT_CONTRAST_MIN}:1 on every surface of the row`, () => {
        const colors = diffCountColors(tokens);
        expect(colors).toBeDefined();
        const surfaces = diffCountSurfaces(tokens)!;
        expect(surfaces.length).toBe(3);
        for (const [name, hex] of Object.entries(colors!)) {
          for (const surface of surfaces) {
            const ratio = contrastRatio(parseCssColor(hex)!, surface);
            expect(ratio, `${name} ${hex}`).toBeGreaterThanOrEqual(DIFF_COUNT_CONTRAST_MIN);
          }
        }
      });

      test(`${id} / ${mode}: + stays green-ish, - stays red-ish, and the two stay apart`, () => {
        const colors = diffCountColors(tokens)!;
        const add = lch(colors.additions);
        const del = lch(colors.deletions);
        const success = lch(tokens.success!);
        const destructive = lch(tokens.destructive!);
        // A palette may choose other hues (colorblind: blue and orange); then
        // the count keeps the palette's own hue. A token with no hue at all
        // (a palette that draws deletions in its text colour) gets the usual one.
        for (const [label, got, own, wanted] of [
          ['+', add, success, isGreenish],
          ['-', del, destructive, isReddish],
        ] as const) {
          expect(got.C, `${label} ${JSON.stringify(got)} has a visible hue`).toBeGreaterThanOrEqual(0.05);
          if (own.C >= 0.03) expect(hueDistance(got.H, own.H), `${label} keeps the palette's hue`).toBeLessThanOrEqual(6);
          if (own.C < 0.03 || wanted(own.H)) expect(wanted(got.H), `${label} hue ${got.H.toFixed(0)}`).toBe(true);
        }
        expect(hueDistance(add.H, del.H), 'the + and - hues stay apart').toBeGreaterThanOrEqual(60);
      });
    }
  }

  test('a count that already reads is left as the palette drew it', () => {
    const colors = diffCountColors({
      background: '#ffffff',
      foreground: '#111111',
      card: '#ffffff',
      muted: '#f4f4f4',
      primary: '#4f46e5',
      success: '#0b6b2e',
      destructive: '#9f1c1c',
    })!;
    expect(colors).toEqual({ additions: '#0b6b2e', deletions: '#9f1c1c' });
  });

  test('a count that does not read keeps its hue and chroma and moves only its lightness', () => {
    // A pale green and a pale red on white get darker; they do not turn grey.
    const colors = diffCountColors({ background: '#ffffff', foreground: '#111111', success: '#86efac', destructive: '#fca5a5' })!;
    const add = lch(colors.additions);
    const del = lch(colors.deletions);
    expect(hueDistance(add.H, lch('#86efac').H)).toBeLessThan(3);
    expect(hueDistance(del.H, lch('#fca5a5').H)).toBeLessThan(3);
    expect(add.L).toBeLessThan(lch('#86efac').L);
    expect(add.C).toBeGreaterThan(0.08);
    expect(del.C).toBeGreaterThan(0.08);
  });

  test('a token with no hue gets the usual green or red', () => {
    const colors = diffCountColors({ background: '#ffffff', foreground: '#111111', success: '#3fb950', destructive: '#141413' })!;
    expect(isReddish(lch(colors.deletions).H)).toBe(true);
  });

  test('no colours without the tokens to measure them (the plain tokens are drawn instead)', () => {
    expect(diffCountColors(undefined)).toBeUndefined();
    expect(diffCountColors({ background: '#000000' })).toBeUndefined();
  });
});
