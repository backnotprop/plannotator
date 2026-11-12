import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compositeOver, contrastRatio, mixOklab, parseCssColor, quantize, type RgbColor } from '../../utils/cssColor';
import { STAMP_LOGOS } from '../../../shared/shape/stamp-data';
import { SHAPE_COLOR_NAMES, SHAPE_ZONES, shapeBoardIsDark, shapeContrastFixes, shapeLogoFill, type ShapeColors } from './shapeContrast';
import { SHAPE_FRAME_CSS } from './ShapeDrawn';

const themesDir = join(import.meta.dir, '..', '..', 'themes');
const themeFiles = readdirSync(themesDir).filter((f) => f.endsWith('.css')).sort();
const WHITE: RgbColor = { r: 1, g: 1, b: 1, a: 1 };

function block(css: string, selector: string): Record<string, string> | undefined {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!rule[1]!.split(',').map((s) => s.trim()).includes(selector)) continue;
    const out: Record<string, string> = {};
    for (const m of rule[2]!.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
    return out;
  }
  return undefined;
}

function boardVars(themeCss: string, id: string, mode: 'light' | 'dark'): Record<string, string> {
  const base = block(themeCss, `.theme-${id}`) ?? {};
  const tokens = mode === 'light' ? { ...base, ...block(themeCss, `.theme-${id}.light`) } : base;
  const shapeCss = readFileSync(join(import.meta.dir, 'shape.css'), 'utf8');
  return { ...tokens, ...block(shapeCss, '.shp-root'), ...block(SHAPE_FRAME_CSS, '.board') };
}

function resolve(value: string, vars: Record<string, string>, depth = 0): RgbColor {
  if (depth > 12) throw new Error(`var() loop at ${value}`);
  const v = value.trim();
  const ref = v.match(/^var\(--([a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (ref) {
    const own = vars[ref[1]!];
    if (own !== undefined) return resolve(own, vars, depth + 1);
    if (ref[2] !== undefined) return resolve(ref[2], vars, depth + 1);
    throw new Error(`--${ref[1]} is not set`);
  }
  const mix = v.match(/^color-mix\(in oklab,\s*([\s\S]+)\)$/);
  if (mix) {
    const args: string[] = [];
    let depthP = 0, start = 0;
    for (let i = 0; i < mix[1]!.length; i++) {
      const ch = mix[1]![i];
      if (ch === '(') depthP++;
      else if (ch === ')') depthP--;
      else if (ch === ',' && depthP === 0) (args.push(mix[1]!.slice(start, i)), (start = i + 1));
    }
    args.push(mix[1]!.slice(start));
    const [a, b] = args.map((x) => x.trim().match(/^([\s\S]+?)(?:\s+([\d.]+)%)?$/)!);
    const p = Number(a![2] ?? (b![2] ? 100 - Number(b![2]) : 50)) / 100;
    const A = resolve(a![1]!, vars, depth + 1);
    if (b![1]!.trim() === 'transparent') return { ...A, a: A.a * p };
    return mixOklab(A, resolve(b![1]!, vars, depth + 1), 1 - p);
  }
  const c = parseCssColor(v);
  if (!c) throw new Error(`cannot read ${v}`);
  return c;
}

function boardColors(vars: Record<string, string>): ShapeColors {
  const out = {} as ShapeColors;
  for (const name of SHAPE_COLOR_NAMES) out[name] = resolve(`var(--${name})`, vars);
  return out;
}

const ratio = (c: RgbColor, ground: RgbColor) => contrastRatio(quantize(compositeOver(c, ground)), ground);

function shortfalls(c: ShapeColors, fixes: Record<string, string>): string[] {
  const col = (name: (typeof SHAPE_COLOR_NAMES)[number]) => parseCssColor(fixes[`--${name}`]) ?? c[name];
  const paper = quantize(compositeOver(c.paper, compositeOver(c.background, WHITE)));
  const surface = quantize(compositeOver(c.surface, paper));
  const ink = quantize(compositeOver(c.ink, paper));
  const soft = Object.fromEntries([...SHAPE_ZONES, 'alert'].map((z) => [z, quantize(compositeOver(col(`${z}-soft` as never), paper))]));
  const bar = (ground: RgbColor) => Math.min(4.5, ratio(ink, ground));
  const out: string[] = [];
  const check = (what: string, c2: RgbColor, grounds: Record<string, RgbColor>) => {
    for (const [g, ground] of Object.entries(grounds)) {
      const r = ratio(c2, ground);
      if (r < bar(ground) - 1e-9) out.push(`${what} on ${g}: ${r.toFixed(2)} (needs ${bar(ground).toFixed(2)})`);
    }
  };
  for (const z of SHAPE_ZONES) check(z, col(z), { paper, [`${z}-soft`]: soft[z]!, surface });
  const everywhere = { paper, surface, ...Object.fromEntries(Object.entries(soft).map(([z, s]) => [`${z}-soft`, s])) };
  check('alert', col('alert'), everywhere);
  const markSoft = col('mark-soft');
  check('mark', col('mark'), { ...everywhere, ...Object.fromEntries(Object.entries(everywhere).map(([g, s]) => [`mark-soft on ${g}`, quantize(compositeOver(markSoft, s))])) });
  check('grey', col('grey'), everywhere);
  check('ink2', col('ink2'), everywhere);
  for (const [z, s] of Object.entries(soft)) {
    const r = ratio(ink, s);
    if (r < Math.min(4.5, ratio(ink, paper), ratio(ink, surface)) - 1e-9) out.push(`ink on ${z}-soft: ${r.toFixed(2)}`);
  }
  return out;
}

const LOGOS = Object.entries(STAMP_LOGOS).filter(([, l]) => l.c).map(([slug, l]) => [slug, parseCssColor(l.c)!] as const);

describe('a drawn board in every shipped palette', () => {
  for (const file of themeFiles) {
    const id = file.replace(/\.css$/, '');
    const css = readFileSync(join(themesDir, file), 'utf8');
    for (const mode of ['dark', 'light'] as const) {
      test(`${id} / ${mode}: words and zone colours >= 4.5:1, logos on a dark board >= 3:1`, () => {
        const c = boardColors(boardVars(css, id, mode));
        const fixes = shapeContrastFixes(c);
        expect(shortfalls(c, fixes)).toEqual([]);
        const paper = quantize(compositeOver(c.paper, compositeOver(c.background, WHITE)));
        const ink = quantize(compositeOver(c.ink, paper));
        const grounds = [paper, quantize(compositeOver(c.surface, paper)), ...[...SHAPE_ZONES, 'alert'].map((z) => parseCssColor(fixes[`--${z}-soft`]) ?? quantize(compositeOver(c[`${z}-soft` as never], paper)))];
        const faint: string[] = [];
        for (const [slug, logo] of LOGOS) {
          const fill = shapeLogoFill(logo, c, fixes);
          if (!shapeBoardIsDark(c)) {
            if (fill !== null) faint.push(`${slug} recoloured on a light board`);
            continue;
          }
          const shown = parseCssColor(fill) ?? logo;
          for (const g of grounds) if (ratio(shown, g) < Math.min(3, ratio(ink, g)) - 1e-9) faint.push(`${slug} ${ratio(shown, g).toFixed(2)}`);
        }
        expect(faint).toEqual([]);
      });
    }
  }

  test('only a colour that falls short is changed: every other one is drawn exactly as the frame draws it', () => {
    for (const file of themeFiles) {
      const id = file.replace(/\.css$/, '');
      const css = readFileSync(join(themesDir, file), 'utf8');
      for (const mode of ['dark', 'light'] as const) {
        const c = boardColors(boardVars(css, id, mode));
        const short = shortfalls(c, {});
        for (const name of Object.keys(shapeContrastFixes(c))) {
          const fell = short.some((line) => (name.endsWith('-soft') ? line.startsWith(`ink on ${name.slice(2)}:`) : line.startsWith(`${name.slice(2)} on `)));
          expect(fell, `${id} / ${mode} changes ${name}, which held`).toBe(true);
        }
      }
    }
  });

  test('a palette whose zone words fall short as drawn gets them fixed (Dracula)', () => {
    const c = boardColors(boardVars(readFileSync(join(themesDir, 'dracula.css'), 'utf8'), 'dracula', 'dark'));
    expect(shortfalls(c, {}).length).toBeGreaterThan(0);
    expect(shortfalls(c, shapeContrastFixes(c))).toEqual([]);
  });
});
