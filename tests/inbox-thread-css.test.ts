import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INBOX_CSS_PATH,
  parseCss,
  renderInboxThreadCss,
  stripComments,
  type CssNode,
} from '../packages/ui/scripts/build-inbox-thread-css';

// @plannotator/ui/inbox-thread.css is generated from the Inbox's own stylesheet
// and loaded into another app's page. A rule in inbox.css that styles the
// window as a whole (`body`, `html:has(.pn-inbox)`, `body:has(.pn-inbox) input`)
// is right in the Inbox and wrong in a host, where it restyles pages that have
// nothing to do with a thread, and only on some screens. These checks run the
// generator over the real inbox.css and read the output from the outside, so a
// new rule in inbox.css cannot reach a host page unnoticed.

const PARTS = resolve(import.meta.dir, '../packages/ui/components/inbox-thread');
const source = readFileSync(INBOX_CSS_PATH, 'utf8');
const generated = renderInboxThreadCss(source);

interface FlatRule {
  selector: string;
  /** The at-rules around the rule, outermost first. */
  within: string[];
  body: string;
}

function flatRules(nodes: readonly CssNode[], within: string[] = []): FlatRule[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'rule') return node.selectors.map((selector) => ({ selector, within, body: node.body }));
    if (node.kind === 'group') return flatRules(node.children, [...within, node.prelude]);
    return [];
  });
}

function atRules(nodes: readonly CssNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'rule') return [];
    return node.kind === 'group' ? [node.prelude, ...atRules(node.children)] : [node.prelude];
  });
}

/** A selector as compounds and combinators, with bracketed arguments emptied and the scope kept. */
function topLevelTokens(selector: string): string[] {
  let flat = selector.replace(/\\./g, '_').replaceAll(':where(.pn-inbox)', '.pn-inbox');
  for (let previous = ''; previous !== flat; ) {
    previous = flat;
    flat = flat.replace(/\([^()]*\)/g, '').replace(/\[[^[\]]*\]/g, '');
  }
  return flat
    .replace(/\s*([>+~])\s*/g, ' $1 ')
    .trim()
    .split(/\s+/);
}

const isPageElement = (compound: string) => /^(:root|html|body|#root)(?![\w-])/.test(compound);

/** True unless what the selector matches has to be `.pn-inbox` or inside it. */
function reachesOutside(selector: string): boolean {
  const tokens = topLevelTokens(selector);
  return !tokens.some((token, i) => /\.pn-inbox(?![\w-])/.test(token) && tokens[i + 1] !== '+' && tokens[i + 1] !== '~');
}

/** A rule for the page's root that only sets the sheet's own tokens paints nothing there. */
function onlySetsTokens(body: string): boolean {
  return body
    .replace(/\([^()]*\)/g, '')
    .split(';')
    .map((declaration) => declaration.split(':')[0]!.trim())
    .filter(Boolean)
    .every((name) => name.startsWith('--ib-'));
}

function leaksOf(css: string): FlatRule[] {
  return flatRules(parseCss(css)).filter(({ selector, body }) => {
    if (!reachesOutside(selector)) return false;
    const tokens = topLevelTokens(selector);
    return !(tokens.length === 1 && isPageElement(tokens[0]!) && onlySetsTokens(body));
  });
}

const rules = flatRules(parseCss(generated.css));

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
    '.pn-inbox ~ div .ib-row',
    '.pn-inbox-other .ib-row',
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
    const page = rules.filter(({ selector }) => {
      const tokens = topLevelTokens(selector);
      const subject = tokens[tokens.length - 1]!;
      return /^(html|body|#root)(?![\w-])/.test(subject);
    });
    expect(page.map(({ selector }) => selector)).toEqual([]);
  });

  test('what stays on :root is --ib-* tokens only', () => {
    const roots = rules.filter(({ selector }) => {
      const tokens = topLevelTokens(selector);
      return tokens.length === 1 && isPageElement(tokens[0]!);
    });
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.filter(({ body }) => !onlySetsTokens(body)).map(({ selector, body }) => `${selector} { ${body} }`)).toEqual([]);
  });

  test('every name the sheet makes global carries the ib- prefix', () => {
    const at = atRules(parseCss(generated.css));
    const named = (pattern: RegExp) => at.flatMap((rule) => pattern.exec(rule)?.[1] ?? []);
    expect(named(/^@keyframes\s+(\S+)/).length).toBeGreaterThan(0);
    expect(named(/^@keyframes\s+(\S+)/).filter((name) => !name.startsWith('ib-'))).toEqual([]);
    expect(named(/^@property\s+(\S+)/).filter((name) => !name.startsWith('--ib-'))).toEqual([]);
    expect(named(/^@container\s+([a-z][\w-]*)\s/).filter((name) => !name.startsWith('ib-'))).toEqual([]);
    const highlights = rules.flatMap(({ selector }) => [...selector.matchAll(/::highlight\(([^)]+)\)/g)].map((match) => match[1]!));
    expect(highlights.filter((name) => !name.startsWith('ib-'))).toEqual([]);
  });

  test('only Tailwind base and the sheet\'s own layer are named, so a host\'s layer order stays its own', () => {
    const layers = new Set(atRules(parseCss(generated.css)).flatMap((rule) => /^@layer\s+(.+)/.exec(rule)?.[1] ?? []));
    expect([...layers].sort()).toEqual(['base', 'ib-type']);
  });

  test('the sheet declares no fonts, imports nothing and asks for no file', () => {
    const kinds = new Set(atRules(parseCss(generated.css)).map((rule) => /^@[\w-]+/.exec(rule)![0]));
    expect([...kinds].filter((kind) => !['@media', '@supports', '@container', '@layer', '@keyframes', '@property'].includes(kind))).toEqual([]);
    const urls = [...generated.css.matchAll(/url\(\s*["']?([^"')]{0,12})/g)].map((match) => match[1]!);
    expect(urls.filter((url) => !url.startsWith('data:'))).toEqual([]);
  });

  test('every animation in the sheet names keyframes the sheet declares', () => {
    const declared = new Set(atRules(parseCss(generated.css)).flatMap((rule) => /^@keyframes\s+(\S+)/.exec(rule)?.[1] ?? []));
    const used = rules.flatMap(({ body }) => [...body.matchAll(/(?:^|[;\s])animation(?:-name)?\s*:\s*([^;]+)/g)].flatMap((match) => match[1]!.match(/\bib-[\w-]+|\btp-[\w-]+/g) ?? []));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });

  test('the file carries no comment', () => {
    expect(stripComments(generated.css)).toBe(generated.css);
  });
});

describe('the host gets the Inbox\'s cascade', () => {
  const unscoped = (text: string) => text.replaceAll(':where(.pn-inbox) ', '');
  const keyed = ({ selector, within, body }: FlatRule) => `${within.join(' / ')} ## ${unscoped(selector)} ## ${body}`;

  test('every rule ships in the source\'s order, with no specificity added, but for the page\'s own', () => {
    const droppedKeys = new Set(generated.dropped.map((rule) => keyed({ selector: rule.selector, within: rule.within, body: rule.body })));
    const renames = [...generated.renamedKeyframes];
    const renamed = (body: string) => renames.reduce((text, [from, to]) => text.replaceAll(` ${from} `, ` ${to} `), body);
    const expected = flatRules(parseCss(stripComments(source)))
      .filter((rule) => !droppedKeys.has(keyed(rule)))
      .map((rule) => keyed({ ...rule, body: renamed(rule.body) }));
    expect(rules.map(keyed)).toEqual(expected);
  });

  test('only a rule that ends on the page itself is dropped', () => {
    expect(generated.dropped.length).toBeGreaterThan(0);
    const notThePage = generated.dropped.filter(({ selector }) => {
      const tokens = topLevelTokens(selector);
      return tokens.length !== 1 || !isPageElement(tokens[0]!);
    });
    expect(notThePage.map(({ selector }) => selector)).toEqual([]);
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

  test('keyframes outside the ib- namespace move into it with their uses', () => {
    expect(probed.css).toContain('@keyframes ib-spin');
    expect(probed.css).toContain('animation: ib-spin 1s linear infinite');
    expect(probed.css).not.toContain('@keyframes spin');
  });

  test.each([
    ['@font-face', '@font-face { font-family: "Host"; src: url("a.woff2"); }'],
    ['@import', '@import "other.css";'],
    ['@view-transition', '@view-transition { navigation: auto; }'],
    ['@page', '@page { margin: 0; }'],
    ['a nested rule', '.ib-row { color: red; .ib-mk { color: blue; } }'],
  ])('%s fails the build', (_name, css) => {
    expect(() => renderInboxThreadCss(css)).toThrow();
  });
});
