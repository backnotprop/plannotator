import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface StyleRule {
  selectors: string[];
  within: string[];
  body: string;
}

export function styleRules(css: string): StyleRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: StyleRule[] = [];
  const stack: Array<{ prelude: string; rule: StyleRule | null }> = [];
  let prelude = '';
  for (const char of text) {
    if (char === '{') {
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

function rowHoverSelectors(rule: StyleRule): string[] {
  return rule.selectors.filter((s) => /\.ib-rw(?::[\w-]+(?:\([^)]*\))?)*:(?:hover|is\([^)]*:hover)/.test(s));
}

const hovers = (prelude: string) => /^@media\b/.test(prelude) && /\(\s*hover\s*:\s*hover\s*\)/.test(prelude) && !prelude.includes(',');

export function unguardedRowHovers(css: string): string[] {
  return styleRules(css)
    .filter((rule) => !rule.within.some(hovers))
    .flatMap(rowHoverSelectors);
}

const sheet = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');

describe("a list row's hover action on a touch screen", () => {
  test('the check catches a row hover outside (hover: hover) and passes one inside it', () => {
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

const noHover = (prelude: string) => /^@media\b/.test(prelude) && /\(\s*hover\s*:\s*none\s*\)/.test(prelude) && !prelude.includes(',');

const SIDEBAR_ON_TOUCH: Array<{ selector: string; sets: RegExp; why: string }> = [
  { selector: '.pn-inbox :is(.ib-projrow, .ib-pinrow) .ib-pmore', sets: /opacity:\s*1\b/, why: 'a project or starred row\'s ⋯' },
  { selector: '.pn-inbox .ib-projrow .ib-pplus', sets: /opacity:\s*1\b/, why: "a project row's +" },
  { selector: '.ib-projrow:hover .ib-proj .ib-n', sets: /clip-path:\s*none/, why: "a project's count, under a tap's hover" },
  { selector: '.ib-pinrow:hover .ib-pin > :is(.ib-n, .ib-spill, .ib-pdot, .ib-parch)', sets: /visibility:\s*visible/, why: "a starred row's state, under a tap's hover" },
];

export function sidebarHiddenOnTouch(css: string): string[] {
  const touch = styleRules(css).filter((rule) => rule.within.some(noHover));
  return SIDEBAR_ON_TOUCH.filter(({ selector, sets }) => !touch.some((rule) => rule.selectors.includes(selector) && sets.test(rule.body))).map((e) => e.why);
}

describe("the sidebar's ⋯ and + on a touch screen", () => {
  test('the check catches a sheet that hides them until hover, and passes one that shows them', () => {
    const before = '.pn-inbox .ib-pmore { opacity: 0; } .ib-projrow:hover .ib-pmore { opacity: 1; }';
    expect(sidebarHiddenOnTouch(before)).toHaveLength(SIDEBAR_ON_TOUCH.length);
    const phoneOnly = `@media (max-width: 767px), (hover: none) { ${SIDEBAR_ON_TOUCH.map((e) => `${e.selector} { x: 1; }`).join(' ')} }`;
    expect(sidebarHiddenOnTouch(phoneOnly)).toHaveLength(SIDEBAR_ON_TOUCH.length);
  });

  test("the Inbox's sheet always shows them, with the count and state, where the pointer cannot hover", () => {
    expect(sidebarHiddenOnTouch(sheet)).toEqual([]);
  });

  test('with a mouse they still show on hover, and stay hidden until then', () => {
    const plain = styleRules(sheet).filter((rule) => rule.within.length === 0);
    const sets = (selector: string, decl: RegExp) => plain.some((rule) => rule.selectors.includes(selector) && decl.test(rule.body));
    expect(sets('.pn-inbox .ib-pmore', /opacity:\s*0\b/)).toBe(true);
    expect(sets('.pn-inbox .ib-pplus', /opacity:\s*0\b/)).toBe(true);
    expect(sets('.ib-projrow:hover .ib-pmore', /opacity:\s*1\b/)).toBe(true);
    expect(sets('.ib-pinrow:hover .ib-pmore', /opacity:\s*1\b/)).toBe(true);
    expect(sets('.ib-projrow:hover .ib-pplus', /opacity:\s*1\b/)).toBe(true);
  });
});
