import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { NEVER_IN_THE_INBOX, PAGE_MARKS, normalizeSelector, rewriteInboxCss } from '../build/inbox-page-marks';

const repoRoot = resolve(import.meta.dir, '..');
const ENTRY = join(repoRoot, 'apps/inbox/index.css');

function windowSheets(file = ENTRY, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const css = readFileSync(file, 'utf8');
  const nested = [...css.matchAll(/@import\s+["'](\.{1,2}\/[^"']+\.css)["']/g)].flatMap((m) => windowSheets(resolve(dirname(file), m[1]!), seen));
  return [file, ...nested];
}

function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  const out: string[] = [];
  for (const m of text.matchAll(/([^{};]+)\{/g)) {
    const prelude = m[1]!.trim();
    if (!prelude || prelude.startsWith('@')) continue;
    out.push(...prelude.split(/,(?![^(]*\))/).map(normalizeSelector));
  }
  return out;
}

const ANCHORED = /(?:^|[\s>+~(,])(?:html|body|:root|\.pn-inbox)(?:\[[^\]]*\]|\.[\w-]+|:root)*:has\(/;

function specificity(selector: string): [number, number, number] {
  const flat = selector.replace(/:has\(/g, ' (').replace(/[()]/g, ' ');
  const ids = flat.match(/#[\w-]+/g)?.length ?? 0;
  const classes = flat.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g)?.length ?? 0;
  const types = flat.match(/(?:^|[\s>+~])[a-z][\w-]*/g)?.length ?? 0;
  return [ids, classes, types];
}

describe('the window\'s sheets, rewritten', () => {
  const sheets = windowSheets().map((file) => ({ file, css: readFileSync(file, 'utf8') }));
  const results = sheets.map(({ file, css }) => ({ file, ...rewriteInboxCss(css) }));

  test('no :has() anchored on the page or the window\'s root is left', () => {
    const left = results.flatMap(({ file, css }) => selectors(css).filter((s) => ANCHORED.test(s)).map((s) => `${file.slice(repoRoot.length + 1)}: ${s}`));
    expect(left).toEqual([]);
  });

  test('every mark stands for a :has() a sheet still writes', () => {
    const used = new Set(results.flatMap(({ used }) => [...used.keys()]));
    expect(PAGE_MARKS.map(({ has }) => has).filter((has) => !used.has(has))).toEqual([]);
  });

  test('each mark weighs what its :has() weighed', () => {
    for (const { has, mark } of PAGE_MARKS) expect([mark, specificity(mark)]).toEqual([mark, specificity(has)]);
  });

  test('only rules on the plan and code review apps\' attributes are dropped', () => {
    const dropped = results.flatMap(({ dropped }) => dropped);
    expect(dropped.length).toBeGreaterThan(0);
    for (const selector of dropped) expect(NEVER_IN_THE_INBOX.some((name) => selector.includes(`[${name}`))).toBe(true);
  });

  test('those attributes are set only by the plan and code review apps', () => {
    const files = Bun.spawnSync(['git', 'ls-files', 'packages/*.tsx', 'packages/*.ts', 'apps/*.tsx', 'apps/*.ts'], { cwd: repoRoot })
      .stdout.toString()
      .split('\n')
      .filter((file) => file && !/\.test\.tsx?$/.test(file) && !file.includes('node_modules/'));
    const setters = new Set<string>();
    for (const file of files) {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      for (const name of NEVER_IN_THE_INBOX) {
        const camel = name.replace(/^data-/, '').replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
        if (text.includes(`${name}=`) || text.includes(`'${name}'`) || text.includes(`"${name}"`) || text.includes(`dataset.${camel}`)) setters.add(file);
      }
    }
    expect([...setters].sort()).toEqual(['packages/editor/App.tsx', 'packages/review-editor/App.tsx']);
  });

  test('the parts each mark stands for are drawn only by the components that hold it', () => {
    const holders: Record<string, string[]> = {
      'ib-dm-pill': ['packages/inbox/decisions/entry.tsx'],
      'ib-imgcompose': ['packages/inbox/components/ImageAttachmentView.tsx', 'packages/inbox/components/VideoAttachmentView.tsx'],
      'ib-fcomp': ['packages/inbox/components/FullScreenComposer.tsx'],
      'ib-rpick': ['packages/inbox/components/ReplyRecipient.tsx'],
      'shp-dock': ['packages/ui/components/shape/ShapeSurface.tsx'],
      'shp-pill': ['packages/ui/components/shape/ShapeSurface.tsx'],
      'pn-inbox': ['packages/inbox/App.tsx', 'packages/inbox/tour/Tour.tsx'],
    };
    const files = Bun.spawnSync(['git', 'ls-files', 'packages/inbox/*.tsx', 'packages/ui/*.tsx', 'packages/review-editor/*.tsx', 'apps/inbox/*.tsx'], { cwd: repoRoot })
      .stdout.toString()
      .split('\n')
      .filter((file) => file && !/\.test\.tsx$/.test(file) && !file.includes('/standalone/'));
    const drawn: Record<string, string[]> = {};
    for (const name of Object.keys(holders)) drawn[name] = [];
    for (const file of files) {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      for (const name of Object.keys(holders)) {
        if (new RegExp(`className=\\{?[\`"'][^\`"']*(?<![\\w-])${name}(?![\\w-])`).test(text)) drawn[name]!.push(file);
      }
    }
    expect(drawn).toEqual(holders);
  });
});

describe('rewriteInboxCss', () => {
  test('rewrites in place and leaves what is around it as it was', () => {
    const css = [
      '@layer base, components;',
      '@layer later {}',
      '/* a } in a comment */',
      '.a { content: "} {"; }',
      'html:has(.pn-inbox) .x, .y { color: red; }',
      '@media (width < 600px) { /* only */ html:has([data-pn-browser-canvas="card"]) .z { color: blue; } }',
      '@media print { body:has(.pn-inbox) { margin: 0; } }',
    ].join('\n');
    const { css: out, used, dropped } = rewriteInboxCss(css);
    expect(out).toBe(
      [
        '@layer base, components;',
        '@layer later {}',
        '/* a } in a comment */',
        '.a { content: "} {"; }',
        'html[data-pn-inbox] .x, .y { color: red; }',
        '@media print { body[data-pn-inbox] { margin: 0; } }',
      ].join('\n'),
    );
    expect(Object.fromEntries(used)).toEqual({ 'html:has(.pn-inbox)': 1, 'body:has(.pn-inbox)': 1 });
    expect(dropped).toEqual(['html:has([data-pn-browser-canvas=card]) .z']);
  });

  test('a whole compound only: `.pn-inbox:has(.ib-fcomp-x)` is not `.pn-inbox:has(.ib-fcomp)`', () => {
    const css = '.pn-inbox:has(.ib-fcomp-x) .a { color: red; }';
    expect(rewriteInboxCss(css).css).toBe(css);
  });
});
