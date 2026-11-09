/**
 * Plannotator Modern's dark palette is the PaulMillr palette (owner, 2026-11-09). The two live in two files,
 * because the palette sweeps read each theme from its own file (softGround.test.ts, diffCountColors.test.ts).
 * What regresses if this fails: one of the two is edited and Modern dark stops being PaulMillr's dark, in its
 * colors or in the syntax theme its code is drawn in.
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

/** Modern's own: PaulMillr's blue (#396bd7) a step brighter, on the button and the ring (owner, 2026-11-09). */
const MODERN_OWN = { '--primary': '#336be9', '--ring': '#336be9' };

test("Plannotator Modern's dark colors are PaulMillr's, token for token, but for its blue", () => {
  const paulmillr = colors(tokens('paulmillr.css', '.theme-paulmillr'));
  expect(Object.keys(paulmillr).length).toBeGreaterThan(20);
  expect(paulmillr['--primary']).toBe(paulmillr['--ring']!);
  expect(colors(tokens('plannotator-modern.css', '.theme-plannotator-modern'))).toEqual({ ...paulmillr, ...MODERN_OWN });
});

test("Plannotator Modern's dark code is drawn in the syntax theme PaulMillr's is", () => {
  expect(resolveSyntaxTheme('plannotator-modern', 'dark')).toEqual(resolveSyntaxTheme('paulmillr', 'dark'));
});
