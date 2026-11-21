/**
 * No `:has()` rule in the Inbox's sheet may end, after a combinator, in a part
 * with nothing to key on (`X:has(…) > *`, `X:has(…) > :not(.a)`).
 *
 * Chromium keeps one invalidation set for what follows every `:has()` in the
 * page. One such part makes it "every descendant", and then any DOM change
 * under an element a `:has()` rule is anchored on (html, body, .pn-inbox and
 * the thread's foot all are) restyles the whole page. React gives the reply
 * box's textarea a new text node on every key, so each key restyled ~3,500
 * elements on a long thread: 34 ms a key at 4x CPU slowdown, the larger half
 * of the typing lag on a phone (2026-11-02, the reply box perf fix). Write
 * such a rule with the `:has()` on the element it styles instead
 * (`X > :not(.a):has(~ .b)`), or key it on a class.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every selector in a stylesheet (comments and declarations dropped, at-rule preludes skipped). */
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

/** Split on `sep` outside parentheses and brackets. */
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

/** A selector's compounds, left to right (combinators outside parentheses split them). */
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

/** Drop each `:name(…)` group, nested parentheses included. */
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

/** Whether Chromium can key an invalidation on the compound: a class, id, attribute or type, outside :not() and :has(). */
function hasFeature(compound: string): boolean {
  const rest = dropPseudo(dropPseudo(compound, 'not'), 'has');
  return /[.#[]/.test(rest) || /(^|[(,]\s*)[a-z]/i.test(rest);
}

/** The selectors whose part after a `:has()` (past a combinator) has nothing to key on. */
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
