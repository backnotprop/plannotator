import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_CSS_PATH, parseSheet, renderInboxThreadCss, topLevel } from '../packages/ui/scripts/build-inbox-thread-css';

// @plannotator/ui/inbox-thread.css is generated from the Inbox's own stylesheet
// and loaded into another app's page. A rule in inbox.css that styles the
// window as a whole (`body`, `html:has(.pn-inbox)`, `body:has(.pn-inbox) input`)
// is right in the Inbox and wrong in a host, where it restyles pages that have
// nothing to do with a thread, and only on some screens. These checks run the
// generator over the real inbox.css and read the output from the outside, with
// postcss, so a new rule in inbox.css cannot reach a host page unnoticed.

const PARTS = resolve(import.meta.dir, '../packages/ui/components/inbox-thread');
const source = readFileSync(INBOX_CSS_PATH, 'utf8');
const generated = renderInboxThreadCss(source);

interface FlatRule {
  selector: string;
  /** The at-rules around the rule, outermost first. */
  within: string[];
  props: string[];
  body: string;
}

const atRuleName = (rule: { name: string; params: string }) => `@${rule.name} ${rule.params}`.replace(/\s+/g, ' ').trim();

/** Every selector of every style rule, keyframe steps aside. */
function flatRules(css: string): FlatRule[] {
  const out: FlatRule[] = [];
  parseSheet(css).walkRules((rule) => {
    const within: string[] = [];
    for (let at = rule.parent; at && at.type === 'atrule'; at = at.parent) within.unshift(atRuleName(at as never));
    if (within.some((name) => name.startsWith('@keyframes'))) return;
    const declarations = rule.nodes.flatMap((node) => (node.type === 'decl' ? [node] : []));
    const body = declarations.map((decl) => `${decl.prop}:${decl.value}${decl.important ? '!' : ''}`).join(';');
    const props = declarations.map((decl) => decl.prop);
    for (const selector of rule.selectors) out.push({ selector: selector.replace(/\s+/g, ' '), within, props, body });
  });
  return out;
}

function atRules(css: string): string[] {
  const out: string[] = [];
  parseSheet(css).walkAtRules((rule) => {
    out.push(atRuleName(rule));
  });
  return out;
}

const isPageElement = (compound: string) => /^(:root|html|body|#root)(?![\w-])/.test(compound);

/** True unless what the selector matches has to be `.pn-inbox` or inside it. */
function reachesOutside(selector: string): boolean {
  const tokens = topLevel(selector);
  return !tokens.some((token, i) => /\.pn-inbox(?![\w-])/.test(token) && tokens[i + 1] !== '+' && tokens[i + 1] !== '~');
}

/** A rule for the page's root that only sets the sheet's own tokens paints nothing there. */
const onlySetsTokens = ({ props }: FlatRule) => props.every((name) => name.startsWith('--ib-'));

function leaksOf(css: string): FlatRule[] {
  return flatRules(css).filter((rule) => {
    if (!reachesOutside(rule.selector)) return false;
    const tokens = topLevel(rule.selector);
    return !(tokens.length === 1 && isPageElement(tokens[0]!) && onlySetsTokens(rule));
  });
}

const rules = flatRules(generated.css);
const at = atRules(generated.css);

describe('the guard can see a leak', () => {
  test.each([
    'body',
    '#root',
    '*',
    'button',
    '.ib-row',
    'pre code.pn-code',
    '[data-local-link="unavailable"]',
    'html:has(.pn-inbox)',
    'body:has(.pn-inbox) input',
    '.ib-row:not(.pn-inbox)',
    '.pn-inbox + .ib-row',
    '.pn-inbox+.ib-row',
    '.pn-inbox ~ div .ib-row',
    '.pn-inbox-other .ib-row',
    '[data-x=".pn-inbox"] .ib-row',
  ])('%s reaches outside', (selector) => {
    expect(reachesOutside(selector)).toBe(true);
  });

  test.each(['.pn-inbox', '.pn-inbox *', '.pn-inbox > .ib-row', ':where(.pn-inbox) .ib-row', ':root.light .pn-inbox .ib-row', ':root.light :where(.pn-inbox) .ib-a + .ib-b'])(
    '%s stays inside',
    (selector) => {
      expect(reachesOutside(selector)).toBe(false);
    },
  );
});

describe('nothing in inbox-thread.css can style outside .pn-inbox', () => {
  test('the real source has rules to check', () => {
    expect(rules.length).toBeGreaterThan(1000);
  });

  test('every selector needs a .pn-inbox root, but for token-only rules on :root', () => {
    expect(leaksOf(generated.css).map(({ selector, within }) => [selector, ...within].join(' in '))).toEqual([]);
  });

  test('no rule for html, body or #root remains', () => {
    const page = rules.filter(({ selector }) => /^(html|body|#root)(?![\w-])/.test(topLevel(selector).at(-1)!));
    expect(page.map(({ selector }) => selector)).toEqual([]);
  });

  test('what stays on :root is --ib-* tokens only', () => {
    const roots = rules.filter(({ selector }) => {
      const tokens = topLevel(selector);
      return tokens.length === 1 && isPageElement(tokens[0]!);
    });
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.filter((rule) => !onlySetsTokens(rule)).map(({ selector, body }) => `${selector} { ${body} }`)).toEqual([]);
  });

  test('every name the sheet makes global carries the ib- prefix', () => {
    const named = (pattern: RegExp) => at.flatMap((rule) => pattern.exec(rule)?.[1] ?? []);
    expect(named(/^@keyframes\s+(\S+)/).length).toBeGreaterThan(0);
    expect(named(/^@keyframes\s+(\S+)/).filter((name) => !name.startsWith('ib-'))).toEqual([]);
    expect(named(/^@property\s+(\S+)/).filter((name) => !name.startsWith('--ib-'))).toEqual([]);
    expect(named(/^@container\s+([a-z][\w-]*)\s/).filter((name) => !name.startsWith('ib-'))).toEqual([]);
    const highlights = rules.flatMap(({ selector }) => [...selector.matchAll(/::highlight\(([^)]+)\)/g)].map((match) => match[1]!));
    expect(highlights.filter((name) => !name.startsWith('ib-'))).toEqual([]);
  });

  test('only Tailwind base and the sheet\'s own layer are named, so a host\'s layer order stays its own', () => {
    const layers = new Set(at.flatMap((rule) => /^@layer\s+(.+)/.exec(rule)?.[1] ?? []));
    expect([...layers].sort()).toEqual(['base', 'ib-type']);
  });

  test('the sheet declares no fonts, imports nothing and asks for no file', () => {
    const kinds = new Set(at.map((rule) => /^@[\w-]+/.exec(rule)![0]));
    expect([...kinds].filter((kind) => !['@media', '@supports', '@container', '@layer', '@keyframes', '@property'].includes(kind))).toEqual([]);
    const urls = [...generated.css.matchAll(/url\(\s*["']?([^"')]{0,12})/g)].map((match) => match[1]!);
    expect(urls.filter((url) => !url.startsWith('data:'))).toEqual([]);
  });

  test('every animation in the sheet names keyframes the sheet declares', () => {
    const declared = new Set(at.flatMap((rule) => /^@keyframes\s+(\S+)/.exec(rule)?.[1] ?? []));
    const used: string[] = [];
    parseSheet(generated.css).walkDecls(/^(?:-[a-z]+-)?animation(?:-name)?$/i, (decl) => {
      used.push(...(decl.value.match(/(?<![\w-])(?:ib|tp)-[\w-]+/g) ?? []));
    });
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });

  test('the file carries no comment', () => {
    let comments = 0;
    parseSheet(generated.css).walkComments(() => {
      comments++;
    });
    expect(comments).toBe(0);
    expect(generated.css).not.toContain('/*');
  });
});

describe('the host gets the Inbox\'s cascade', () => {
  const unscoped = (text: string) => text.replaceAll(':where(.pn-inbox) ', '');
  const where = ({ selector, within }: { selector: string; within: string[] }) => `${within.join(' / ')} ## ${selector}`;
  const keyed = (rule: FlatRule) => `${where({ ...rule, selector: unscoped(rule.selector) })} ## ${rule.body}`;

  test('every rule ships in the source\'s order, with no specificity added, but for the page\'s own', () => {
    const droppedKeys = new Set(generated.dropped.map(where));
    const renamed = (body: string) => [...generated.renamedKeyframes].reduce((text, [from, to]) => text.replace(new RegExp(`(?<![\\w-])${from}(?![\\w-])`, 'g'), to), body);
    const expected = flatRules(source)
      .filter((rule) => !droppedKeys.has(where(rule)))
      .map((rule) => keyed({ ...rule, body: renamed(rule.body) }));
    expect(rules.map(keyed)).toEqual(expected);
  });

  test('only a rule that ends on the page itself is dropped', () => {
    expect(generated.dropped.map(({ selector }) => selector).sort()).toEqual(
      ['#root', ':root[data-ib-keyboard-pin]:has(.pn-inbox)', 'body', 'body:has(.pn-inbox)', 'html', 'html.ib-theme-instant', 'html:has(.pn-inbox)'].sort(),
    );
  });
});

describe('every ib- class of the shared parts has a rule', () => {
  // A hook, not a look: the Inbox draws these from the rules around them, so no rule exists to ship.
  const NO_RULE_IN_THE_INBOX: ReadonlySet<string> = new Set(['ib-skills-n']);

  const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const used = new Set(
    readdirSync(PARTS)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .flatMap((name) => withoutComments(readFileSync(join(PARTS, name), 'utf8')).match(/(?<![\w-])ib-[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []),
  );
  const ruled = new Set(rules.flatMap(({ selector }) => selector.match(/\.ib-[\w-]+/g)?.map((name) => name.slice(1)) ?? []));

  test('the parts use classes', () => {
    expect(used.size).toBeGreaterThan(10);
  });

  test('each one is in the sheet', () => {
    expect([...used].filter((name) => !ruled.has(name) && !NO_RULE_IN_THE_INBOX.has(name))).toEqual([]);
  });

  test('a class excused above is still used and still has no rule', () => {
    expect([...NO_RULE_IN_THE_INBOX].filter((name) => !used.has(name) || ruled.has(name))).toEqual([]);
  });
});

describe('the generator, on what the source could grow', () => {
  const PROBE = `
    /* a comment */
    html, body, #root { height: 100%; }
    html:has(.pn-inbox), body:has(.pn-inbox) { background: red; }
    :root[data-pin]:has(.pn-inbox) { overflow: hidden; }
    body:has(.pn-inbox) input { font-size: 16px; }
    :root { --ib-token: 1; }
    :root { --ib-token: 1; color: red; }
    :root { --not-ours: 1; }
    * { margin: 0; }
    button { color: red; }
    .ib-row, .tp, pre code.pn-code { color: red; }
    .pn-inbox + .ib-row { color: red; }
    :root.light .ib-row > .ib-mk { color: red; }
    ::highlight(ib-mark) { color: red; }
    @media (max-width: 767px) { body { background: red; } .ib-row { color: blue; } }
    @layer base { html { margin: 0; } .pn-inbox * { box-sizing: border-box; } }
    @keyframes spin { to { opacity: 1; } }
    .pn-inbox .ib-spin { animation: spin 1s linear infinite; }
  `;
  const probed = renderInboxThreadCss(PROBE);

  test('no leak survives', () => {
    expect(leaksOf(probed.css).map(({ selector }) => selector)).toEqual([]);
  });

  test('a rule on the page is dropped, whatever it hides behind', () => {
    expect(probed.dropped.map(({ selector }) => selector).sort()).toEqual(
      ['#root', ':root', ':root', ':root[data-pin]:has(.pn-inbox)', 'body', 'body', 'body:has(.pn-inbox)', 'html', 'html', 'html:has(.pn-inbox)'].sort(),
    );
  });

  test('a group left empty is not shipped', () => {
    expect(renderInboxThreadCss('@media (max-width: 767px) { body { margin: 0; } }').css).toBe('');
  });

  test('a comment goes wherever it was written', () => {
    const { css } = renderInboxThreadCss('.ib-a /* a */ , .ib-b { color /* b */ : /* c */ red /* d */ ; margin: 0; /* e */ } @media /* f */ (width > 1px) /* g */ { .ib-c { color: red } }');
    expect(css).not.toContain('/*');
    expect(flatRules(css).map(({ selector, body }) => `${selector} ${body}`)).toEqual([':where(.pn-inbox) .ib-a color:red;margin:0', ':where(.pn-inbox) .ib-b color:red;margin:0', ':where(.pn-inbox) .ib-c color:red']);
  });

  test('keyframes outside the ib- namespace move into it with their uses', () => {
    expect(probed.css).toContain('@keyframes ib-spin');
    expect(probed.css).toContain('animation: ib-spin 1s linear infinite');
    expect(probed.css).not.toContain('@keyframes spin');
  });

  test.each([
    ['ANIMATION: spin 1s'],
    ['Animation-Name: spin'],
    ['animation-name: other, spin'],
    ['-webkit-animation: spin 1s'],
  ])('%s follows the rename, whatever the property\'s case', (declaration) => {
    const { css } = renderInboxThreadCss(`@keyframes spin { to { opacity: 1; } } .ib-a { ${declaration}; }`);
    expect(css).toMatch(/\.ib-a \{ [^}]*\bib-spin\b/);
    expect(css).not.toMatch(/\.ib-a \{ [^}]*(?<![\w-])spin\b/);
  });

  test('a name that only contains a keyframe name is left alone', () => {
    const { css } = renderInboxThreadCss('@keyframes spin { to { opacity: 1; } } .ib-a { animation: spinner 1s; --ib-spin: 1; --spin-size: 2px; }');
    expect(css).toContain('animation: spinner 1s; --ib-spin: 1; --spin-size: 2px;');
  });

  test('a keyframe name already in the namespace may sit in a custom property', () => {
    expect(() => renderInboxThreadCss('@keyframes ib-spin { to { opacity: 1; } } .ib-a { --anim: ib-spin 1s; animation: var(--anim); }')).not.toThrow();
  });

  test.each([
    ['@font-face', '@font-face { font-family: "Host"; src: url("a.woff2"); }'],
    ['@import', '@import "other.css";'],
    ['@view-transition', '@view-transition { navigation: auto; }'],
    ['@page', '@page { margin: 0; }'],
    ['a statement @layer', '@layer base, ib-type;'],
    ['an uppercase at-rule', '@MEDIA (width > 1px) { .ib-a { color: red; } }'],
    ['a declaration outside a rule', 'color: red;'],
    ['a declaration in a group', '@media (width > 1px) { color: red; }'],
    ['a nested rule', '.ib-row { color: red; .ib-mk { color: blue; } }'],
    ['a nested at-rule', '.ib-row { @media (width > 1px) { color: blue; } }'],
    ['body > x', 'body > .ib-row { color: red; }'],
    ['body>x', 'body>.ib-row { color: red; }'],
    ['body + x', 'body + .ib-row { color: red; }'],
    [':root ~ x', ':root ~ .ib-row { color: red; }'],
    ['html > body x', 'html > body .ib-row { color: red; }'],
    ['a leading combinator', '> .ib-row { color: red; }'],
    ['a keyframe name in a custom property', '@keyframes spin { to { opacity: 1; } } .ib-a { --anim: spin 1s; animation: var(--anim); }'],
    ['a quoted keyframe name', '@keyframes "spin" { to { opacity: 1; } }'],
    ['an unclosed block', '.ib-a { color: red;'],
  ])('%s fails the build', (_name, css) => {
    expect(() => renderInboxThreadCss(css)).toThrow();
  });
});
