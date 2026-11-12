import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkShapeBoard, shapeParts, shapeViewContent } from './shape';
import { SHAPE_GUIDE, SHAPE_HELP_INTRO, SHAPE_SKILL } from './shape-skill';
import { KETTLE_CHANGED, kettleBoard } from '../../tests/fixtures/shape-whats-changed';

const KNOW = /\bknow\b/i;

describe('agents are not asked for views.know', () => {
  test('the shape help, the /shape skill and the kit never mention know', () => {
    const help = `${SHAPE_HELP_INTRO}\n\n${SHAPE_GUIDE}`;
    const kit = readFileSync(join(import.meta.dir, 'shape-kit.mjs'), 'utf8');
    for (const [name, text] of [['help', help], ['skill', SHAPE_SKILL.body], ['kit', kit]] as const) {
      expect({ name, know: text.match(KNOW)?.[0] ?? null }).toEqual({ name, know: null });
      expect(text).not.toContain('What to know');
    }
  });

  test("the help's own example board passes the check", () => {
    const json = SHAPE_GUIDE.match(/## The board's JSON\n\n```json\n([\s\S]*?)\n```/)?.[1];
    expect(json).toBeDefined();
    const example = JSON.parse(json!.replaceAll('…', ''));
    expect(example.views.know).toBeUndefined();
    expect(example.views.changed).toBeUndefined();
    expect(example.refs.some((r: { sub?: string }) => r.sub)).toBe(true);
  });
});

describe('a board that has views.know is still taken', () => {
  test('the check takes it and keeps the words, but they are not parts: nothing shows them', () => {
    const r = checkShapeBoard({
      title: 'T',
      claim: 'C',
      views: { picture: { html: '<p data-mark="a">A</p>' }, know: 'First [^1].\n\nSecond.' },
      refs: [{ n: 1, kind: 'link', title: 'R', target: 'https://example.com' }],
    });
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (!r.ok) return;
    expect(shapeViewContent(r.value.views, 'know')).toBe('First [^1].\n\nSecond.');
    expect(shapeParts(r.value).filter((p) => p.view === 'know')).toEqual([]);
  });
});

describe('agents are not asked for views.changed', () => {
  test("the shape help, the /shape skill and the kit never mention views.changed or What's changed", () => {
    const help = `${SHAPE_HELP_INTRO}\n\n${SHAPE_GUIDE}`;
    const kit = readFileSync(join(import.meta.dir, 'shape-kit.mjs'), 'utf8');
    for (const [name, text] of [['help', help], ['skill', SHAPE_SKILL.body], ['kit', kit]] as const) {
      const found = text.match(/views\.changed|what's changed|"changed"\s*:|\bchanged\s*[,}]/i)?.[0] ?? null;
      expect({ name, found }).toEqual({ name, found: null });
    }
  });
});

describe('a board that has views.changed is still taken', () => {
  test('the check takes it and keeps it as written, but it has no parts: nothing shows it', () => {
    const r = checkShapeBoard(kettleBoard());
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (!r.ok) return;
    expect(r.value.views.changed).toEqual(KETTLE_CHANGED);
    expect(shapeParts(r.value).filter((p) => p.view === 'changed')).toEqual([]);
  });
});
