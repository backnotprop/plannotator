import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compositeOver, mixOklab, parseCssColor, rgbToOklab, type RgbColor } from './cssColor';

function tokens(file: string, selector: string): Record<string, string> {
  const css = readFileSync(join(import.meta.dir, '..', 'themes', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1]!.split(',').map((s) => s.trim()).includes(selector)) continue;
    const out: Record<string, string> = {};
    for (const d of rule[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
    return out;
  }
  throw new Error(`${file} has no ${selector} rule`);
}

const color = (t: Record<string, string>, name: string): RgbColor => {
  const c = parseCssColor(t[name]);
  if (!c) throw new Error(`no ${name}`);
  return c;
};
const alpha = (c: RgbColor, a: number): RgbColor => ({ ...c, a });

function steps(t: Record<string, string>): Record<string, number> {
  const card = color(t, '--card');
  const muted = color(t, '--muted');
  const surfaces: Record<string, RgbColor> = {
    'section band (--ib-band: muted 75% into card)': mixOklab(card, muted, 0.75),
    'quiet and foot buttons (muted at 60% on card)': compositeOver(alpha(muted, 0.6), card),
    'row hover (--ib-hover: muted at 45% on card)': compositeOver(alpha(muted, 0.45), card),
    'border on card': color(t, '--border'),
    'popover on card': color(t, '--popover'),
  };
  const L = (c: RgbColor) => rgbToOklab(c).L;
  return Object.fromEntries(Object.entries(surfaces).map(([name, c]) => [name, Math.abs(L(c) - L(card))]));
}

test("Modern dark's bands, quiet buttons, hovers, lines and menus stand off the card at least as far as Plannotator dark's", () => {
  const modern = steps(tokens('plannotator-modern.css', '.theme-plannotator-modern'));
  const original = steps(tokens('plannotator.css', '.theme-plannotator'));
  for (const name of Object.keys(original)) {
    expect(original[name]!, name).toBeGreaterThan(0.015);
    expect(modern[name]!, `${name}: Modern ${modern[name]!.toFixed(3)} vs Plannotator ${original[name]!.toFixed(3)}`).toBeGreaterThanOrEqual(original[name]!);
  }
});
