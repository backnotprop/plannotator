import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSheet } from '../packages/ui/scripts/build-inbox-thread-css';

const ROOT = resolve(import.meta.dir, '..');
const KNOWN = ['packages/editor/index.css', 'packages/inbox/inbox.css', 'packages/review-editor/index.css'];

function trackedCss(): string[] {
  const out = Bun.spawnSync(['git', 'ls-files', '-z', '--', '*.css'], { cwd: ROOT });
  if (out.exitCode !== 0) return KNOWN;
  return out.stdout.toString().split('\0').filter(Boolean);
}

interface Rule { file: string; selector: string; decls: Map<string, string> }

function keepLayoutRules(file: string): Rule[] {
  const rules: Rule[] = [];
  parseSheet(readFileSync(resolve(ROOT, file), 'utf8')).walkRules((rule) => {
    const decls = new Map<string, string>();
    rule.walkDecls((decl) => { decls.set(decl.prop, decl.value.trim()); });
    for (const selector of rule.selectors) {
      if (/pre code\.pn-code\[data-keep-layout\]$/.test(selector.trim()) && decls.get('white-space') === 'pre') {
        rules.push({ file, selector: selector.trim(), decls });
      }
    }
  });
  return rules;
}

const rules = trackedCss().flatMap(keepLayoutRules);

test('every app that draws fences has a keep-layout rule', () => {
  expect([...new Set(rules.map((rule) => rule.file))].sort()).toEqual(expect.arrayContaining(KNOWN));
});

test('a keep-layout fence is as wide as its longest line, so its background scrolls with it', () => {
  const short = rules.filter(({ decls }) => decls.get('min-width') !== 'max-content' && decls.get('width') !== 'max-content');
  expect(short.map(({ file, selector }) => `${file}: ${selector}`)).toEqual([]);
});
