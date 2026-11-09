/**
 * Sharp's lines in every shipped palette (sharpContrast.ts; approvals "shape-board-style-switch", "shape-board-sharp-only").
 *
 * What regresses if these fail:
 * - a 1 px box border falls under 3:1, a connector (and its filled head) under 5:1, or a zone's edge under 3:1 on
 *   the paper or its own fill, in some palette (a fixed CSS mix holds on the default palette and not on a soft
 *   dark one or a light one with a grey ink: the fixes must cover each);
 * - the default palette stops drawing exactly the look the owner approved (no fix there, the frame's own mixes);
 * - Sharp's quieter zone fills cost a word: every word colour must read on a Sharp zone at least as well as on the
 *   palette's own zone fill (the frame's `--*-soft`), or at 4.5:1.
 *
 * No DOM: the board's colours are worked out from `SHAPE_FRAME_CSS` as written (its `.board` rule and the Sharp rule; their
 * `color-mix()` and `var()` chains), over each palette's tokens read from `packages/ui/themes` as text, so a change
 * to either stylesheet or a new palette is swept too.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compositeOver, contrastRatio, mixOklab, parseCssColor, quantize, type RgbColor } from '../../utils/cssColor';
import { SHAPE_FRAME_CSS } from './ShapeDrawn';
import {
  SHAPE_SHARP_COLOR_NAMES,
  SHAPE_SHARP_EDGE_MIN,
  SHAPE_SHARP_HAIR_MIN,
  SHAPE_SHARP_WIRE_MIN,
  SHAPE_SHARP_ZONES,
  shapeSharpFixes,
  shapeSharpGrounds,
  type ShapeSharpColors,
} from './sharpContrast';

const themesDir = join(import.meta.dir, '..', '..', 'themes');
const themeFiles = readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort();
expect(themeFiles.length).toBeGreaterThan(30);

/** The custom properties a rule whose selector is exactly `selector` declares. */
function declarations(css: string, selector: string): Record<string, string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!rule[1]!.split(',').map((s) => s.trim()).includes(selector)) continue;
    const out: Record<string, string> = {};
    for (const m of rule[2]!.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
    return out;
  }
  return {};
}

/** The frame's own colours (the palette's zone fills), and Sharp's over them. */
const FRAME = declarations(SHAPE_FRAME_CSS, '.board');
const SHARP = { ...FRAME, ...declarations(SHAPE_FRAME_CSS, '.board[data-shp-style="sharp"]') };

/** Split on the commas at the top level of `s`. */
function args(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(at, i).trim());
      at = i + 1;
    }
  }
  out.push(s.slice(at).trim());
  return out;
}

/** A value the frame writes, as the page resolves it: `var()` through the frame, then the palette; `color-mix(in oklab, …)`. */
function resolver(frame: Record<string, string>, theme: Record<string, string>) {
  const resolve = (value: string): RgbColor => {
    const v = value.trim();
    const ref = /^var\((--[a-z0-9-]+)(?:\s*,\s*([\s\S]+))?\)$/.exec(v);
    if (ref) {
      const name = ref[1]!.slice(2);
      if (frame[name] !== undefined) return resolve(frame[name]!);
      if (theme[name] !== undefined) return resolve(theme[name]!);
      if (ref[2] !== undefined) return resolve(ref[2]);
      throw new Error(`unresolved ${ref[1]}`);
    }
    const mix = /^color-mix\(in oklab,\s*([\s\S]+)\)$/.exec(v);
    if (mix) {
      const [a, b] = args(mix[1]!);
      const m = /^([\s\S]+?)\s+([\d.]+)%$/.exec(a!);
      if (!m) throw new Error(`mix without a share: ${v}`);
      const p = Number(m[2]) / 100;
      const top = resolve(m[1]!);
      if (b === 'transparent') return { ...top, a: top.a * p };
      return mixOklab(resolve(b!), top, p);
    }
    const c = parseCssColor(v);
    if (!c) throw new Error(`not a colour: ${v}`);
    return c;
  };
  return resolve;
}

const ratio = (c: RgbColor, ground: RgbColor) => contrastRatio(quantize(compositeOver(c, ground)), ground);
const hex = (s: string) => parseCssColor(s)!;

for (const file of themeFiles) {
  const css = readFileSync(join(themesDir, file), 'utf8');
  const id = file.replace(/\.css$/, '');
  for (const mode of ['dark', 'light'] as const) {
    const theme = declarations(css, mode === 'dark' ? `.theme-${id}` : `.theme-${id}.light`);
    if (!theme.background) continue;
    describe(`${id} / ${mode}`, () => {
      const sharp = resolver(SHARP, theme);
      const colors = Object.fromEntries(SHAPE_SHARP_COLOR_NAMES.map((n) => [n, sharp(`var(--${n})`)])) as ShapeSharpColors;
      const fixes = shapeSharpFixes(colors);
      const shown = (name: string) => (fixes[`--${name}`] ? hex(fixes[`--${name}`]!) : colors[name as keyof ShapeSharpColors]);
      const g = shapeSharpGrounds(colors);
      const bar = (min: number, ground: RgbColor) => Math.min(min, contrastRatio(g.ink, ground));

      test(`Sharp's lines hold: borders ${SHAPE_SHARP_HAIR_MIN}:1, connectors ${SHAPE_SHARP_WIRE_MIN}:1, zone edges ${SHAPE_SHARP_EDGE_MIN}:1`, () => {
        const failures: string[] = [];
        const check = (what: string, line: RgbColor, grounds: [string, RgbColor][], min: number) => {
          for (const [where, ground] of grounds) {
            const r = ratio(line, ground);
            if (r < bar(min, ground) - 0.005) failures.push(`${what} on ${where}: ${r.toFixed(2)}`);
          }
        };
        const softs = SHAPE_SHARP_ZONES.map((z) => [`${z} zone`, g.soft[z]] as [string, RgbColor]);
        check('border', shown('shp-hair'), [['paper', g.paper], ['a box', g.surface], ...softs], SHAPE_SHARP_HAIR_MIN);
        check('connector', shown('shp-wire'), [['paper', g.paper], ...softs], SHAPE_SHARP_WIRE_MIN);
        for (const z of SHAPE_SHARP_ZONES) check(`${z} edge`, shown(`shp-zone-${z}`), [['paper', g.paper], [`its fill`, g.soft[z]]], SHAPE_SHARP_EDGE_MIN);
        expect(failures).toEqual([]);
      });

      test("a word reads on a Sharp zone at least as well as on the palette's own zone fill, or at 4.5:1", () => {
        const own = resolver(FRAME, theme);
        const paper = quantize(compositeOver(sharp('var(--paper)'), quantize(compositeOver(sharp('var(--background)'), { r: 1, g: 1, b: 1, a: 1 }))));
        const failures: string[] = [];
        for (const word of ['ink', 'ink2', 'grey', 'mark', 'alert', ...SHAPE_SHARP_ZONES]) {
          for (const z of SHAPE_SHARP_ZONES) {
            const before = quantize(compositeOver(own(`var(--${z}-soft)`), paper));
            const now = quantize(compositeOver(sharp(`var(--${z}-soft)`), paper));
            const was = ratio(sharp(`var(--${word})`), before);
            const is = ratio(sharp(`var(--${word})`), now);
            if (is < Math.min(4.5, was) - 0.005) failures.push(`--${word} on the ${z} zone: ${is.toFixed(2)} (the palette's fill ${was.toFixed(2)})`);
          }
        }
        expect(failures).toEqual([]);
      });
    });
  }
}

test('the default palette draws the approved look: the frame mixes hold, nothing is fixed', () => {
  const css = readFileSync(join(themesDir, 'plannotator.css'), 'utf8');
  for (const selector of ['.theme-plannotator', '.theme-plannotator.light']) {
    const sharp = resolver(SHARP, declarations(css, selector));
    const colors = Object.fromEntries(SHAPE_SHARP_COLOR_NAMES.map((n) => [n, sharp(`var(--${n})`)])) as ShapeSharpColors;
    expect(shapeSharpFixes(colors)).toEqual({});
  }
});
