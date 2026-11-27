/**
 * Ship under reduced motion (approval "inbox-ship-mode"): every animation pulls/ship.css starts is turned off in its
 * `prefers-reduced-motion: reduce` block, not only hidden. What regresses: a new or changed animated part (the glint,
 * a pool, the launch fill, the sail, the agent's mark) left running for a person who asked for no motion. The browser
 * check of the same rows is the e2e's "dark theme and reduced motion" test.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, 'ship.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the block that opens at `start` (the index of its `{`), by matching braces. */
function blockAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return text.slice(start + 1, i);
  }
  throw new Error('unclosed block');
}

const REDUCED = '@media (prefers-reduced-motion: reduce)';
const reducedAt = css.indexOf(REDUCED);
const reduced = blockAt(css, css.indexOf('{', reducedAt));
const outside = (css.slice(0, reducedAt) + css.slice(reducedAt + REDUCED.length + reduced.length + 2)).replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

test('every animation Ship starts is set to none under reduced motion', () => {
  const animated = rules(outside)
    .filter((rule) => /(^|;)\s*animation(-name)?\s*:\s*(?!none)/.test(rule.body))
    .map((rule) => /(\.[\w-]+(?:\s*>\s*span)?)\s*$/.exec(rule.selector)?.[1]?.replace(/\s+/g, ' '));
  expect(animated.length).toBeGreaterThan(5);
  const off = rules(reduced)
    .filter((rule) => /(^|;)\s*animation\s*:\s*none/.test(rule.body))
    .map((rule) => rule.selector.replace(/\s+/g, ' '));
  const left = animated.filter((part) => !part || !off.some((selector) => selector.includes(part)));
  expect(left).toEqual([]);
});
