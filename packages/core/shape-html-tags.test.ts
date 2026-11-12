import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shapeHtmlHasEventHandler, shapeHtmlProblems, shapeHtmlTags } from './shape';
import { SHAPE_OUTSIDE_HTML, SHAPE_SAFE_HTML } from '../../tests/fixtures/shape-outside-loads';

const TAG_RE = /<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ON_RE = /<[^>]*\son[a-z]+\s*=/i;
const regexTags = (html: string) => [...html.matchAll(TAG_RE)].map((m) => ({ name: m[1]!, attrs: m[2] ?? '' }));

const ROOT = join(import.meta.dir, '../..');

function repoHtml(): string[] {
  const files = [
    'packages/core/shape.test.ts',
    'packages/ui/components/shape/ShapeDrawn.test.tsx',
    'packages/server/inbox-shape-switch.test.ts',
    'tests/e2e/inbox-shape-seed.ts',
    'tests/manual/shape-harness/fixture.ts',
    'tests/fixtures/shape-outside-loads.ts',
  ].map((f) => readFileSync(join(ROOT, f), 'utf8'));
  return [...SHAPE_OUTSIDE_HTML, ...SHAPE_SAFE_HTML, ...files, ...files.flatMap((text) => text.split('\n').filter((line) => line.includes('<')))];
}

function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  '<', '>', '"', "'", '=', ' ', '\t', '\n', ' ', ' ', '/', '-', ':', '_', '1', 'a', 'o', 'n', 'x', 'O', 'N',
  '<a', '<A', '<div ', '<p\t', '<svg>', '</a>', '<1', '<-', '<<', '>>', 'on', 'ON', ' on', ' onclick', ' onClick=', ' on=', ' on1=', ' ona =',
  '="', "='", ' x="', " y='", ' href="https://example.com/a"', ' src="files/a.png"', ' src="https://evil.invalid/x"',
  ' style="background:url(https://evil.invalid/a)"', ' fill="url(#g)"', ' type="image"', ' data-code="src/a.ts#L3"', ' data-code=\'x\'',
  '&colon;', '&quot;', 'javascript:', '<input ', '<script>', '<style>', '<img/', 'data-x', 'xlink:href=',
];

function soup(next: () => number, fixtures: string[]): string {
  const parts: string[] = [];
  const count = Math.floor(next() * 60);
  for (let i = 0; i < count; i++) {
    if (next() < 0.08) {
      const f = fixtures[Math.floor(next() * fixtures.length)]!;
      const a = Math.floor(next() * f.length);
      parts.push(f.slice(a, a + Math.floor(next() * 200)));
    } else parts.push(PIECES[Math.floor(next() * PIECES.length)]!);
  }
  return parts.join('');
}

describe('the one-pass HTML readers match the regexes they replace', () => {
  const fixtures = repoHtml();
  const next = random(2611);
  const cases = [...fixtures, ...Array.from({ length: 20_000 }, () => soup(next, fixtures))];

  test('the same tags, names and attribute text, in the same order', () => {
    const differ = cases.filter((html) => JSON.stringify(shapeHtmlTags(html)) !== JSON.stringify(regexTags(html)));
    expect(differ.slice(0, 5)).toEqual([]);
  });

  test('the same event-handler verdict', () => {
    const differ = cases.filter((html) => shapeHtmlHasEventHandler(html) !== ON_RE.test(html));
    expect(differ.slice(0, 5)).toEqual([]);
    expect(cases.some((html) => ON_RE.test(html))).toBe(true);
    expect(cases.some((html) => html.includes('<') && !ON_RE.test(html))).toBe(true);
  });
});

describe('a crafted drawing does not stall the check', () => {
  const UNITS = ['<a', '<a ', '<a x', '<a x="', '<a/data-code=', '<a data-code="', '<div on', '<a x=\'<b y="', '<p\t'];
  for (const unit of UNITS) {
    test(`${JSON.stringify(unit)} repeated to 300,000 characters is checked in well under a second`, () => {
      const html = unit.repeat(Math.floor(300_000 / unit.length));
      const started = performance.now();
      shapeHtmlProblems(html);
      expect(performance.now() - started).toBeLessThan(500);
    });
  }
});
