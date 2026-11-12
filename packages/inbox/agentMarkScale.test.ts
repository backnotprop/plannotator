import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CODE = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
const SCALE = [16, 20, 24, 30, 44];
const CORNER: Record<number, string> = { 16: '5px', 20: '6px', 24: '6px', 30: 'var(--ib-r9-s, 8px)', 44: '10px' };

function rules(code: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(code); m; m = re.exec(code)) out.push({ selector: m[1]!.trim(), body: m[2]! });
  return out;
}

const MARK = /\.ib-mk\b|\.ib-draft-mk\b|\.ib-cpill-ag\b/;

test('the scale is declared once: 16, 20, 24, 30, 44, with the ruled corners', () => {
  const steps = [...CODE.matchAll(/--ib-mark-(\d+):\s*([^;]+);/g)].map((m) => [Number(m[1]), m[2]!.trim()] as const);
  expect(steps.map(([n]) => n)).toEqual(SCALE);
  for (const [n, value] of steps) expect(value).toBe(`${n}px`);
  for (const n of SCALE) expect(CODE).toContain(`--ib-mark-${n}-r: ${CORNER[n]};`);
  for (const m of CODE.matchAll(/--ib-mark-(\d+)/g)) expect(SCALE).toContain(Number(m[1]));
});

test('every rule that sizes an agent mark, or the glyph in one, takes it from the scale', () => {
  const offenders: string[] = [];
  for (const { selector, body } of rules(CODE)) {
    if (!MARK.test(selector) || selector.includes('--ib-mark')) continue;
    for (const decl of body.split(';')) {
      const [prop, ...rest] = decl.split(':');
      const name = prop?.trim();
      if (name !== 'width' && name !== 'height' && name !== 'border-radius') continue;
      const value = rest.join(':').trim();
      if (value === '100%' && selector.includes('.ib-tg-mark')) continue;
      const ok = name === 'border-radius' ? /^var\(--ib-mark-\d+-r\)$/.test(value) : /^var\(--ib-mark-\d+(-g)?\)$/.test(value);
      if (!ok) offenders.push(`${selector} { ${name}: ${value} }`);
    }
  }
  expect(offenders).toEqual([]);
});

test('a mark takes its width, height and corner from one step (a 24 box never gets the 30 corner)', () => {
  const mixed: string[] = [];
  for (const { selector, body } of rules(CODE)) {
    if (!MARK.test(selector)) continue;
    const steps = new Set<string>();
    for (const m of body.matchAll(/(?:^|;)\s*(width|height|border-radius)\s*:\s*var\(--ib-mark-(\d+)(-[rg])?\)/g)) {
      if (m[3] !== '-g') steps.add(m[2]!);
    }
    if (steps.size > 1) mixed.push(`${selector}: ${[...steps].join(' and ')}`);
  }
  expect(mixed).toEqual([]);
});
