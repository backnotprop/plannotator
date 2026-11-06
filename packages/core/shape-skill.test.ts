/**
 * Shape's "What to know" is no longer something agents write (approval "shape-know-removed").
 * What regresses if these fail:
 * - `plannotator shape --help`, the Inbox's `/shape` or the kit an agent prints asks for `views.know` again;
 * - an agent that sends `views.know` anyway (or a saved board that has it) is refused, or its words stop reaching the Shape view.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkShapeBoard, shapeParts, shapeViewContent } from './shape';
import { SHAPE_GUIDE, SHAPE_HELP_INTRO, SHAPE_SKILL } from './shape-skill';

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
    // Its caveat sits behind a number instead.
    expect(example.refs.some((r: { sub?: string }) => r.sub)).toBe(true);
  });
});

describe('a board that has views.know still works', () => {
  test('the check takes it, and its words are the Shape view, each paragraph a part', () => {
    const r = checkShapeBoard({
      title: 'T',
      claim: 'C',
      views: { picture: { html: '<p data-mark="a">A</p>' }, know: 'First [^1].\n\nSecond.' },
      refs: [{ n: 1, kind: 'link', title: 'R', target: 'https://example.com' }],
    });
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (!r.ok) return;
    expect(shapeViewContent(r.value.views, 'know')).toBe('First [^1].\n\nSecond.');
    expect(shapeParts(r.value).filter((p) => p.view === 'know').map((p) => p.id)).toEqual(['know-1', 'know-2']);
  });
});
