/**
 * Plannotator Modern's dark palette is the PaulMillr palette (owner, 2026-11-09). The two live in two files,
 * because the palette sweeps read each theme from its own file (softGround.test.ts, diffCountColors.test.ts).
 * What regresses if this fails: one of the two is edited and Modern dark stops being PaulMillr's dark, in its
 * colors or in the syntax theme its code is drawn in, or its blue stops being the blue of its light half. Its quiet
 * surfaces' greys are its own (owner's report, 2026-11-10: the list's bands and the Reply button did not show).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSyntaxTheme } from './syntaxTheme';

/** The tokens of the rule whose selector list names `selector`. */
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

/** Fonts are each theme's own; everything else is the palette. */
const colors = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => !name.startsWith('--font-')));

/** The only tokens where Modern dark is not PaulMillr's: its blue (PaulMillr's primary and ring, one colour there). */
const MODERN_BLUE_TOKENS = ['--primary', '--ring'];
/** And the greys of its quiet surfaces, a step off the card (modernDarkSurfaces.test.ts says how far). */
const MODERN_SURFACE_TOKENS = ['--muted', '--input', '--popover', '--border'];

test("Plannotator Modern's dark colors are PaulMillr's, token for token, except the blue, which is its light half's, and the quiet surfaces' greys", () => {
  const paulmillr = colors(tokens('paulmillr.css', '.theme-paulmillr'));
  const all = colors(tokens('plannotator-modern.css', '.theme-plannotator-modern'));
  for (const name of MODERN_SURFACE_TOKENS) expect(all[name], name).not.toBe(paulmillr[name]);
  const dark = { ...all, ...Object.fromEntries(MODERN_SURFACE_TOKENS.map((name) => [name, paulmillr[name]])) };
  const lightBlue = tokens('plannotator-modern.css', '.theme-plannotator-modern.light')['--primary']!;
  expect(Object.keys(paulmillr).length).toBeGreaterThan(20);
  // PaulMillr's blue is one colour on both tokens; so is Modern's.
  for (const name of MODERN_BLUE_TOKENS) expect(paulmillr[name]).toBe(paulmillr['--primary']!);
  expect(lightBlue).toBeTruthy();
  expect(dark).toEqual({ ...paulmillr, ...Object.fromEntries(MODERN_BLUE_TOKENS.map((name) => [name, lightBlue])) });
});

test("Plannotator Modern's dark code is drawn in the syntax theme PaulMillr's is", () => {
  expect(resolveSyntaxTheme('plannotator-modern', 'dark')).toEqual(resolveSyntaxTheme('paulmillr', 'dark'));
});
