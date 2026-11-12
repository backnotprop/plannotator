import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSyntaxTheme } from './syntaxTheme';

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

const colors = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('--font-')));

const MODERN_BLUE_TOKENS = ['--primary', '--ring'];
const MODERN_SURFACE_TOKENS = ['--muted', '--input', '--popover', '--border'];

test("Plannotator Modern's dark colors are PaulMillr's, token for token, except the blue, which is its light half's, and the quiet surfaces' greys", () => {
  const paulmillr = colors(tokens('paulmillr.css', '.theme-paulmillr'));
  const all = colors(tokens('plannotator-modern.css', '.theme-plannotator-modern'));
  for (const name of MODERN_SURFACE_TOKENS) expect(all[name], name).not.toBe(paulmillr[name]);
  const dark = { ...all, ...Object.fromEntries(MODERN_SURFACE_TOKENS.map((name) => [name, paulmillr[name]])) };
  const lightBlue = tokens('plannotator-modern.css', '.theme-plannotator-modern.light')['--primary']!;
  expect(Object.keys(paulmillr).length).toBeGreaterThan(20);
  for (const name of MODERN_BLUE_TOKENS) expect(paulmillr[name]).toBe(paulmillr['--primary']!);
  expect(lightBlue).toBeTruthy();
  expect(dark).toEqual({ ...paulmillr, ...Object.fromEntries(MODERN_BLUE_TOKENS.map((name) => [name, lightBlue])) });
});

test("Plannotator Modern's dark code is drawn in the syntax theme PaulMillr's is", () => {
  expect(resolveSyntaxTheme('plannotator-modern', 'dark')).toEqual(resolveSyntaxTheme('paulmillr', 'dark'));
});
