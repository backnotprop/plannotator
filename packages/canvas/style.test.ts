/**
 * Numbers that are written twice, once for the board (the stylesheet) and
 * once for everything that does not read a stylesheet (the still picture of
 * a snapshot, the pointer, the box a heading is given). They must agree, or
 * a snapshot's fallback and its figure show different things and a line is
 * grabbed where it is not drawn.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { INK_PENS, TEXT_FACES, TEXT_SIZES, TEXT_SIZE_PX } from './model/types';
import { HIGHLIGHTER_OPACITY, PEN_WIDTH } from './view/ink-path';

const css = await Bun.file(path.join(import.meta.dir, 'canvas.css')).text();

/** The value of `property` in the first rule whose selector is exactly `selector`. */
function declared(selector: string, property: string): string | null {
  const at = css.indexOf(`\n${selector} {`);
  if (at === -1) return null;
  const body = css.slice(at, css.indexOf('}', at));
  return new RegExp(`[{;\\s]${property}:\\s*([^;]+);`).exec(body)?.[1].trim() ?? null;
}

describe('the stylesheet and the code agree', () => {
  test('each size of bare text is as tall on the board as in the still picture and in the box a heading is given', () => {
    expect(declared('.pcv-text', 'font-size')).toBe(`${TEXT_SIZE_PX.medium}px`);
    for (const size of TEXT_SIZES) {
      if (size === 'medium') continue;
      expect(declared(`.pcv-text[data-size='${size}']`, 'font-size')).toBe(`${TEXT_SIZE_PX[size]}px`);
    }
  });

  test('each face has a family, and each pen is as wide on the board as where the pointer looks for it', () => {
    for (const face of TEXT_FACES) if (face !== 'sans') expect(declared(`.pcv-text[data-face='${face}']`, 'font-family')).toBe(`var(--pcv-${face})`);
    expect(declared('.pcv-ink path', 'stroke-width')).toBe(String(PEN_WIDTH.marker));
    for (const pen of INK_PENS) if (pen !== 'marker') expect(declared(`.pcv-ink[data-pen='${pen}'] path`, 'stroke-width')).toBe(String(PEN_WIDTH[pen]));
    expect(declared(".pcv-ink[data-pen='highlighter'] path", 'stroke-opacity')).toBe(String(HIGHLIGHTER_OPACITY));
  });

  test('every ink and line colour a picture can ask for exists for a light ground and for a dark one', () => {
    for (const ground of ['light', 'dark'] as const) {
      const rule = css.slice(css.indexOf(`.pcv-arrow[data-ground='${ground}'] {`));
      const asked = [...rule.slice(0, rule.indexOf('}')).matchAll(/var\((--pcv-[a-z]+-[ld])\)/g)].map((match) => match[1]);
      expect(asked.length).toBe(9);
      for (const name of asked) {
        expect(name.endsWith(ground === 'light' ? '-l' : '-d')).toBe(true);
        expect(css.includes(`\n  ${name}: `)).toBe(true);
      }
    }
  });

  test('a person\'s mark with no colour from the host is read at 4.5 to 1 or better in both themes', () => {
    // The disc is the ink mixed into the card; the initial is the board's ground. All four are greys, and for a
    // grey in oklab the share of light it gives back is its lightness cubed.
    const share = Number(/\.pcv-face \{[^}]*color-mix\(in oklab, var\(--pcv-ink\) (\d+)%, var\(--pcv-card\)\)/.exec(css)![1]) / 100;
    const lightness = (name: string): number => Number(new RegExp(`\n  ${name}: (?:var\\([a-z-]+, )?oklch\\(([0-9.]+) `).exec(css)![1]);
    const contrast = (a: number, b: number) => (Math.max(a, b) ** 3 + 0.05) / (Math.min(a, b) ** 3 + 0.05);
    const themes = { dark: { ink: lightness('--pcv-ink-d'), card: 0.295, stage: lightness('--pcv-stage-d') }, light: { ink: lightness('--pcv-ink-l'), card: 1, stage: lightness('--pcv-stage-l') } };
    // The card's lightness is written where each theme sets it.
    expect(css).toContain('--pcv-card: var(--card, oklch(0.295 0.006 286));');
    expect(css).toContain('--pcv-card: var(--card, oklch(1 0 0));');
    for (const theme of Object.values(themes)) {
      const disc = theme.ink * share + theme.card * (1 - share);
      expect(contrast(disc, theme.stage)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('a custom colour is exact over a picture only when the picture was looked at', () => {
    const at = css.indexOf("--pcv-stroke: var(--pcv-custom);\n}", css.indexOf('/* Over a picture.'));
    const selectors = css.slice(css.lastIndexOf('*/', at) + 2, css.lastIndexOf('{', at));
    expect(selectors.match(/data-ground='(light|dark)'/g)?.length).toBe(4);
    expect(selectors).not.toContain('[data-ground]');
    expect(selectors).not.toContain("'picture'");
  });
});
