/**
 * Two rules of the scheduled sheet that a screen showed broken. A bare `1fr` grid track grows to its longest content,
 * so a long folder path pushed the editor past a 390-wide pane: every flexible track sets its own minimum. And the
 * native time, date and select controls drew their light-theme icons on the dark theme (a clock you could not see):
 * under the dark theme they take the dark color scheme, as the Ask card's controls do.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSheet } from '../../ui/scripts/build-inbox-thread-css';

const sheet = () => parseSheet(readFileSync(resolve(import.meta.dir, 'scheduled.css'), 'utf8'));

test('no grid track in scheduled.css is a bare fr that a long path can widen', () => {
  const bare: string[] = [];
  sheet().walkDecls('grid-template-columns', (decl) => {
    const outside = decl.value.replace(/minmax\([^)]*\)/g, '');
    if (/\dfr\b/.test(outside)) bare.push(`${(decl.parent as { selector?: string }).selector}: ${decl.value}`);
  });
  expect(bare).toEqual([]);
});

test('the native pickers take the dark color scheme under the dark theme', () => {
  const dark: string[] = [];
  sheet().walkDecls('color-scheme', (decl) => {
    const selector = (decl.parent as { selector?: string }).selector ?? '';
    if (decl.value === 'dark' && selector.startsWith(':root:not(.light)')) dark.push(selector);
  });
  expect(dark.some((selector) => /\.st-pick$/.test(selector))).toBe(true);
});

test('at phone width the list gives the name the room: no Runs column, one track per shown cell, a name on up to two lines', () => {
  const phone = new Map<string, Map<string, string>>();
  sheet().walkAtRules('media', (media) => {
    if (!/max-width:\s*760px/.test(media.params)) return;
    media.walkRules((rule) => {
      const decls = new Map<string, string>();
      rule.walkDecls((decl) => void decls.set(decl.prop, decl.value));
      phone.set(rule.selector, decls);
    });
  });
  expect(phone.get('.st-scols > .st-count')?.get('display')).toBe('none');
  // One grid for the whole narrow list: the name column fits the longest name (capped), then Run in a fixed column, so
  // every row's button is on one line; the heading and the rows are subgrids of it.
  const tracks = (columns: string | undefined) => (columns ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/(fit-content|minmax)\((?:[^()]|\([^()]*\))*\)/g, (m) => m.split('(')[0]!).trim().split(/\s+/);
  expect(tracks(phone.get('.st-short')?.get('grid-template-columns'))).toEqual(['fit-content', '24px', 'minmax', 'auto', '36px']);
  let split: string | undefined;
  let rows: string | undefined;
  sheet().walkRules((rule) => {
    if (rule.parent?.type !== 'root') return;
    if (rule.selector === '.st-short') rule.walkDecls('grid-template-columns', (decl) => void (split = decl.value));
    if (rule.selector === '.st-scols') rule.walkDecls('grid-template-columns', (decl) => void (rows = decl.value));
  });
  expect(tracks(split)).toEqual(['fit-content', '24px', 'minmax', '40px', '112px', '40px']);
  expect(rows).toBe('subgrid');
  // A long name takes two lines at every width of the narrow list.
  let wraps: string | undefined;
  sheet().walkRules('.st-sname .st-open', (rule) => rule.walkDecls('-webkit-line-clamp', (decl) => void (wraps = decl.value)));
  expect(wraps).toBe('2');
  // The wide table at its narrowest (a 768 window) wraps a long name too.
  let narrowWide: string | undefined;
  sheet().walkAtRules('container', (at) => {
    if (/max-width:\s*600px/.test(at.params)) at.walkRules('.st-row .st-open', (rule) => rule.walkDecls('white-space', (decl) => void (narrowWide = decl.value)));
  });
  expect(narrowWide).toBe('normal');
});

test('the wide table: On and Off share one grid whose Name column fits the longest name, so Run sits just right of it at every width', () => {
  const columns = new Map<string, string>();
  sheet().walkDecls('grid-template-columns', (decl) => {
    const rule = decl.parent as { selector?: string; parent?: { type?: string; params?: string } };
    columns.set(`${rule.parent?.type === 'atrule' ? rule.parent.params : 'root'} ${rule.selector}`, decl.value);
  });
  const wide = [...columns].filter(([key]) => key.endsWith(' .st-wgrid'));
  expect(wide.length).toBe(3);
  for (const [, value] of wide) expect(value).toMatch(/^fit-content\((?:[^()]|\([^()]*\))*\) auto /);
  expect(columns.get('root .st-table')).toBe('subgrid');
  expect(columns.get('root .st-cols')).toBe('subgrid');
});

test("on a phone New message's pickers keep their full-screen sheet: the editor's anchoring never reaches a [data-phone] picker", () => {
  const placing: string[] = [];
  sheet().walkRules((rule) => {
    if (!/\.ib-cp-picker/.test(rule.selector)) return;
    rule.walkDecls(/^(top|left|right|bottom|width|position)$/, () => void placing.push(rule.selector));
  });
  expect(placing.length).toBeGreaterThan(0);
  expect([...new Set(placing)].filter((selector) => !selector.includes(':not([data-phone])'))).toEqual([]);
});

test('beside the editor the list hides Runs and gives its room to the name, Run still right of it', () => {
  const split = new Map<string, Map<string, string>>();
  sheet().walkAtRules('media', (media) => {
    if (!/min-width:\s*761px/.test(media.params)) return;
    media.walkRules((rule) => {
      const decls = new Map<string, string>();
      rule.walkDecls((decl) => void decls.set(decl.prop, decl.value));
      split.set(rule.selector, decls);
    });
  });
  expect(split.get('.st-list-split .st-scols > .st-count')?.get('display')).toBe('none');
  const columns = split.get('.st-list-split .st-short')?.get('grid-template-columns') ?? '';
  // Name, Run, the space, Last run, the menu: no Runs track, and the name's cap is Runs' 40px and its gap wider.
  expect([...columns.matchAll(/\[(\w+)\]/g)].map((m) => m[1])).toEqual(['name', 'btn', 'space', 'last', 'more', 'end']);
  expect(columns).toContain('fit-content(calc(100% - 236px))');
});
