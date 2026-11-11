import { expect, test } from 'bun:test';
import { checkShapeBoard, shapeStackBadges, shapeStackHue, shapeStackHues, type ShapeStack } from './shape';

const views = {
  picture: { html: '<div data-mark="pic-a">Kettle</div>' },
  how: { html: '<div data-mark="how-a">Water heats</div><div data-mark="how-b">It boils</div>', tall: { html: '<p data-mark="how-tall">On a phone</p>' } },
};
const stack = (over: Partial<ShapeStack> = {}): ShapeStack => ({
  pulls: [
    { n: 11, title: 'The water', url: 'https://github.com/acme/kettle/pull/11', step: 1 },
    { n: 12, title: 'The boil', step: 2 },
    { n: 13, title: 'The whistle' },
  ],
  changes: [
    { part: 'how-b', pr: 13, said: 'Adds the whistle.', files: [{ path: 'src/whistle.ts', additions: 20 }] },
    { part: 'how-b', pr: 11, said: 'Heats the water to 100.', files: [{ path: 'src/heat.ts', lines: [[3, 9]] }] },
    { part: 'pic-a', pr: 12, said: 'Names the boil.', files: [{ path: 'src/boil.ts' }] },
    { part: 'how-tall', pr: 12, said: 'The phone drawing too.', files: [{ path: 'src/boil.ts' }] },
  ],
  ...over,
});

test('a board keeps the stack its agent wrote, and one without a stack has none', () => {
  const ok = checkShapeBoard({ title: 'Kettle', claim: 'Built.', views, stack: stack() });
  expect(ok.ok).toBe(true);
  if (!ok.ok) return;
  expect(ok.value.stack?.pulls.map((p) => p.n)).toEqual([11, 12, 13]);
  expect(ok.value.stack?.changes.find((c) => c.pr === 11)?.files[0]).toEqual({ path: 'src/heat.ts', lines: [[3, 9]] });
  const none = checkShapeBoard({ title: 'Kettle', claim: 'Built.', views });
  expect(none.ok && none.value.stack).toBeUndefined();
});

test('a badge on a part no drawing has, or for a PR the stack does not list, is refused by field', () => {
  const bad = checkShapeBoard({
    title: 'Kettle',
    claim: 'Built.',
    views,
    stack: stack({
      changes: [
        { part: 'how-z', pr: 11, said: 'Nowhere.', files: [{ path: 'src/a.ts' }] },
        { part: 'how-a', pr: 99, said: 'No such PR.', files: [{ path: 'src/a.ts' }] },
        { part: 'how-a', pr: 11, said: 'Twice.', files: [{ path: 'src/a.ts' }] },
        { part: 'how-a', pr: 11, said: 'Twice.', files: [{ path: 'src/a.ts' }] },
        { part: 'how-a', pr: 12, said: 'No files.', files: [] },
        { part: 'how-b', pr: 12, said: 'Outside.', files: [{ path: '../etc/passwd', lines: [[9, 3]] }] },
      ],
    }),
  });
  expect(bad.ok).toBe(false);
  if (bad.ok) return;
  const at = (field: string) => bad.errors.some((e) => e.startsWith(field));
  expect(at('stack.changes[0].part')).toBe(true);
  expect(at('stack.changes[1].pr')).toBe(true);
  expect(at('stack.changes[3]:')).toBe(true);
  expect(at('stack.changes[4].files')).toBe(true);
  expect(at('stack.changes[5].files[0].path')).toBe(true);
  expect(at('stack.changes[5].files[0].lines[0]')).toBe(true);
  const dup = checkShapeBoard({ title: 'K', claim: 'B.', views, stack: { pulls: [{ n: 1, title: 'a' }, { n: 1, title: 'b' }], changes: [] } });
  expect(!dup.ok && dup.errors.some((e) => e.startsWith('stack.pulls[1].n'))).toBe(true);
  const link = checkShapeBoard({ title: 'K', claim: 'B.', views, stack: { pulls: [{ n: 1, title: 'a', url: 'javascript:alert(1)' }], changes: [] } });
  expect(!link.ok && link.errors.some((e) => e.startsWith('stack.pulls[0].url'))).toBe(true);
});

test('badges come part by part in landing order, and a board of one PR has none', () => {
  const s = stack();
  const badges = shapeStackBadges(s);
  expect(badges.get('how-b')).toEqual([11, 13]);
  expect(badges.get('pic-a')).toEqual([12]);
  expect(badges.has('how-a')).toBe(false);
  expect(shapeStackBadges({ pulls: [s.pulls[0]!], changes: [s.changes[1]!] }).size).toBe(0);
  expect(shapeStackBadges(undefined).size).toBe(0);
});

test('a PR has one colour, by its place in the stack: teal, amber, rose, then one hue each however many', () => {
  const s = stack();
  expect([11, 12, 13].map((n) => shapeStackHue(s, n))).toEqual([186, 72, 357]);
  expect(shapeStackHue(s, 99)).toBeNull();
  const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  for (let count = 2; count <= 20; count++) {
    const hues = shapeStackHues(count);
    expect(hues.length).toBe(count);
    expect(new Set(hues).size).toBe(count);
    for (const h of hues) expect(apart(h, 280)).toBeGreaterThanOrEqual(45);
    for (let i = 1; i < count; i++) expect(apart(hues[i]!, hues[i - 1]!)).toBeGreaterThanOrEqual(24);
  }
});

test('a stack that grows never recolours the PRs already in it', () => {
  const pulls = Array.from({ length: 20 }, (_, i) => ({ n: 500 + i, title: `PR ${i + 1}` }));
  for (let count = 2; count < 20; count++) {
    const before = { pulls: pulls.slice(0, count), changes: [] };
    const after = { pulls: pulls.slice(0, count + 1), changes: [] };
    for (const p of before.pulls) expect(shapeStackHue(after, p.n)).toBe(shapeStackHue(before, p.n));
  }
});
