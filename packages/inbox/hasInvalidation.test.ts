/**
 * No `:has()` rule may end, after a combinator, in a part with nothing to key on (`X:has(…) > *`).
 * Chromium then invalidates every descendant on any DOM change under a `:has()` anchor, restyling the page on each keystroke.
 * Put the `:has()` on the styled element or key on a class.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function selectorsOf(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  let prelude = '';
  let depth = 0;
  for (const char of text) {
    if (char === '{') {
      const head = prelude.trim();
      if (head && !head.startsWith('@')) out.push(...splitTop(head, ','));
      prelude = '';
      depth += 1;
    } else if (char === '}') {
      prelude = '';
      depth = Math.max(0, depth - 1);
    } else if (char === ';') prelude = '';
    else prelude += char;
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    if (char === sep && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

function compoundsOf(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of selector.replace(/\s*([>~+])\s*/g, ' ')) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    if (char === ' ' && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else current += char;
  }
  if (current) out.push(current);
  return out;
}

function dropPseudo(compound: string, name: string): string {
  let out = compound;
  for (let at = out.indexOf(`:${name}(`); at >= 0; at = out.indexOf(`:${name}(`)) {
    let depth = 0;
    let end = at + name.length + 1;
    for (; end < out.length; end++) {
      if (out[end] === '(') depth += 1;
      else if (out[end] === ')' && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(end + 1);
  }
  return out;
}

function hasFeature(compound: string): boolean {
  const rest = dropPseudo(dropPseudo(compound, 'not'), 'has');
  return /[.#[]/.test(rest) || /(^|[(,]\s*)[a-z]/i.test(rest);
}

export function subtreeHasSelectors(css: string): string[] {
  return selectorsOf(css).filter((selector) => {
    const compounds = compoundsOf(selector);
    const first = compounds.findIndex((c) => c.includes(':has('));
    return first >= 0 && first < compounds.length - 1 && !hasFeature(compounds.at(-1)!);
  });
}

describe(':has() invalidation', () => {
  test('the check finds the shapes that restyle the whole page, and passes the rewrites', () => {
    const bad = ['.a:has(> .b) > * { x: 1 }', '.a:has(.v) > :not(.d, .c) { x: 1 }', '.a:has(> .h) > :not(.h) { x: 1 }'];
    const good = [
      '.a > :where(:not(.b)):has(~ .b), .a > .b ~ * { x: 1 }',
      '.a > :not(.d, .c):has(~ :where(.d) .v) { x: 1 }',
      '.a > .h ~ :not(.h) { x: 1 }',
      '.a:has(.v) > :is(.s, .t) { x: 1 }',
      '.pn-inbox :is(button.f, .f:has(> .h)):hover { x: 1 }',
      'body:has(.pn-inbox) :is(input, textarea) { x: 1 }',
      '@media (max-width: 767px) { .a:has(.b) .c { x: 1 } }',
    ];
    for (const rule of bad) expect(subtreeHasSelectors(rule)).not.toEqual([]);
    for (const rule of good) expect(subtreeHasSelectors(rule)).toEqual([]);
  });

  test("the Inbox's sheet has none", () => {
    const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
    expect(selectorsOf(css).filter((s) => s.includes(':has(')).length).toBeGreaterThan(50);
    expect(subtreeHasSelectors(css)).toEqual([]);
  });
});
