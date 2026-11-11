/**
 * A list row's hover action (Mark read, Mark unread, Send now: `.ib-ract`) is
 * shown by `:hover` only where the pointer can hover (`@media (hover: hover)`).
 *
 * iOS and iPadOS Safari apply `:hover` on a finger's first tap, and when that
 * makes a button appear (a `display`, `visibility` or `opacity` change) WebKit
 * treats the tap as a hover and drops its click. On an iPad, opening a thread
 * from the list took two taps: the first showed "Mark read", the second opened
 * the thread. Chromium does not do this, so the browser tests cannot see it:
 * this file reads the sheet instead. Keyboard focus still shows the action.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface StyleRule {
  selectors: string[];
  /** The preludes of the at-rules around the rule, outermost first. */
  within: string[];
  body: string;
}

/** Every style rule in a stylesheet, with the at-rules it sits in (comments dropped). */
export function styleRules(css: string): StyleRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: StyleRule[] = [];
  const stack: Array<{ prelude: string; rule: StyleRule | null }> = [];
  let prelude = '';
  for (const char of text) {
    if (char === '{') {
      // A nested rule's head starts after the last declaration of the rule around it.
      const head = prelude.slice(prelude.lastIndexOf(';') + 1).trim();
      const rule = head && !head.startsWith('@') ? { selectors: splitTop(head), within: stack.filter((s) => !s.rule).map((s) => s.prelude), body: '' } : null;
      if (rule) rules.push(rule);
      stack.push({ prelude: head, rule });
      prelude = '';
    } else if (char === '}') {
      const top = stack.pop();
      if (top?.rule) top.rule.body = prelude.trim();
      prelude = '';
    } else if (char === ';' && !stack.at(-1)?.rule) prelude = '';
    else prelude += char;
  }
  return rules;
}

/** A selector list split on its top-level commas. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/** The selectors where a list row's own `:hover` (`.ib-rw:hover` or `.ib-rw:is(:hover, …)`) styles something in it. */
function rowHoverSelectors(rule: StyleRule): string[] {
  return rule.selectors.filter((s) => /\.ib-rw(?::[\w-]+(?:\([^)]*\))?)*:(?:hover|is\([^)]*:hover)/.test(s));
}

/** An at-rule that holds only where the pointer can hover. */
const hovers = (prelude: string) => /^@media\b/.test(prelude) && /\(\s*hover\s*:\s*hover\s*\)/.test(prelude) && !prelude.includes(',');

/** The row-hover selectors that apply on a screen that cannot hover. */
export function unguardedRowHovers(css: string): string[] {
  return styleRules(css)
    .filter((rule) => !rule.within.some(hovers))
    .flatMap(rowHoverSelectors);
}

const sheet = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');

describe("a list row's hover action on a touch screen", () => {
  test('the check catches a row hover outside (hover: hover) and passes one inside it', () => {
    // The rules as they were when an iPad needed two taps to open a thread.
    const before = [
      '.ib-rw:hover .ib-ract, .ib-rw:has(:focus-visible) .ib-ract { display: inline-flex; }',
      '.pn-inbox .ib-rw:is(:hover, :has(:focus-visible), [data-action-focus]):has(.ib-tick) > .ib-ract { right: 32px; }',
      '@media (max-width: 767px) { .ib-rw:hover:has(.ib-ract) .ib-t { visibility: hidden; } }',
    ];
    for (const css of before) expect(unguardedRowHovers(css)).not.toEqual([]);
    const after = [
      '.ib-rw:has(:focus-visible) .ib-ract { display: inline-flex; }',
      '@media (hover: hover) { .ib-rw:hover .ib-ract { display: inline-flex; } }',
      '@media (hover: hover) and (pointer: fine) { .pn-inbox .ib-rw:hover:has(.ib-tick) > .ib-ract { right: 32px; } }',
    ];
    for (const css of after) expect(unguardedRowHovers(css)).toEqual([]);
  });

  test("the Inbox's sheet shows the action on hover only where the pointer hovers", () => {
    const guarded = styleRules(sheet).filter((rule) => rule.within.some(hovers)).flatMap(rowHoverSelectors);
    // The scan still finds the rules it guards: a rename would otherwise make this a silent pass.
    expect(guarded.some((s) => /^\.ib-rw:hover \.ib-ract$/.test(s))).toBe(true);
    expect(unguardedRowHovers(sheet)).toEqual([]);
  });

  test('keyboard focus still shows the action on any screen', () => {
    const shows = styleRules(sheet).filter(
      (rule) => rule.within.length === 0 && /display:\s*inline-flex/.test(rule.body) && rule.selectors.includes('.ib-rw:has(:focus-visible) .ib-ract'),
    );
    expect(shows.length).toBe(1);
    expect(shows[0]!.selectors).toContain('.ib-rw[data-action-focus] .ib-ract');
  });
});
