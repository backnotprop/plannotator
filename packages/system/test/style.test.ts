import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dir, '..', 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = walk(src);
const css = readFileSync(join(src, 'system.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = files.filter((f) => f.endsWith('.tsx')).map((f) => [f, readFileSync(f, 'utf8')] as const);
const code = files.filter((f) => /\.tsx?$/.test(f)).map((f) => [f, readFileSync(f, 'utf8')] as const);
const TOKENS = new Set(['9', '10', '10-5', '11', '11-5', '12', '12-5', '13', '13-5', '14', '14-5', '15', '15-5', '16', '17', '18', '20', '22', '24', '30', '32', '34']);

describe('system.css', () => {
  test('every font size is an Inbox token with its own px fallback', () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(sizes.length).toBeGreaterThan(20);
    const bad = sizes.filter((v) => {
      const m = /^var\(--ib-fs-([\d-]+), ([\d.]+)px\)$/.exec(v);
      return !m || !TOKENS.has(m[1]!) || m[1]!.replace('-', '.') !== m[2];
    });
    expect(bad).toEqual([]);
  });

  test('every rule names only sys- classes, so nothing reaches into the Inbox and nothing of the Inbox is restyled', () => {
    const classes = [...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
    expect(classes.filter((c) => c !== 'sys' && !c.startsWith('sys-') && c !== 'light')).toEqual([]);
  });

  test('no uppercase labels, no tracking wider than the face, no bar down the left side', () => {
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect([...css.matchAll(/letter-spacing:\s*([^;}]+)/g)].map((m) => m[1]!.trim()).filter((v) => !v.startsWith('-'))).toEqual([]);
    expect(css).not.toMatch(/border-left(-width|-color|-style)?\s*:/);
  });
});

describe('the components', () => {
  test('no Tailwind: every class a component sets is a sys- class', () => {
    const bad: string[] = [];
    for (const [f, text] of tsx) {
      for (const m of text.matchAll(/className=(?:"([^"]*)"|\{([^}]*(?:\{[^}]*\}[^}]*)*)\})/g)) {
        const literal = m[1] ?? '';
        const expr = (m[2] ?? '').replace(/[!=]==\s*(['"])[^'"]*\1/g, '');
        const words = [literal, ...[...expr.matchAll(/'([^']*)'|"([^"]*)"|`([^`$]*)/g)].map((x) => x[1] ?? x[2] ?? x[3] ?? '')].join(' ').split(/\s+/).filter(Boolean);
        for (const w of words) if (w !== 'sys' && !w.startsWith('sys-')) bad.push(`${f.slice(src.length)}: ${w}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('an inline font size goes through fs(), which writes the token', () => {
    const bad = tsx.flatMap(([f, text]) => [...text.matchAll(/fontSize[=:]\s*\{?\s*([^,}\n]+)/g)].filter((m) => !m[1]!.trim().startsWith('fs(')).map((m) => `${f.slice(src.length)}: ${m[0]}`));
    expect(bad).toEqual([]);
  });

  test("none of G's off switches or prototype-only features came over", () => {
    const DENY = [/\bG_OFF\b/, /\bPORTS_OFF\b/, /\blodOf\b/, /\bteach/i, /\bwebmcp\b/i, /\bfetch\(/, /\blocalStorage\b/, /\bwindow\.location\b/, /\bhistory\.(push|replace)State\b/];
    const hits = code.flatMap(([f, text]) => DENY.filter((re) => re.test(text)).map((re) => `${f.slice(src.length)}: ${re}`));
    expect(hits).toEqual([]);
  });
});
