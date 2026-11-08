import { describe, expect, test } from 'bun:test';
import { checkShapeBoard } from './shape';
import { isShapeAnimateHelp, SHAPE_ANIMATE_HELP, SHAPE_ANIMATIONS_SECTION, SHAPE_PICTURE_LOOK } from './shape-animate';
import { SHAPE_GUIDE } from './shape-skill';

describe('shape --help animate', () => {
  // What regresses: the scene format or its validator changes and the one example an agent copies
  // when it animates stops being a board the store takes.
  test('its JSON example is a board with a scene the store accepts', () => {
    const json = SHAPE_ANIMATE_HELP.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(json).toBeDefined();
    const checked = checkShapeBoard(JSON.parse(json!));
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    expect(checked.ok && Object.keys(checked.value.scenes ?? {})).toEqual(['demo']);
  });

  // What regresses: the topic stops being reachable the way the guide tells agents to ask for it,
  // or swallows other shape commands.
  test('the guide points to the topic, and only animate (with or without --help) reaches it', () => {
    expect(SHAPE_ANIMATIONS_SECTION).toContain('plannotator shape --help animate');
    for (const argv of [['--help', 'animate'], ['animate', '--help'], ['animate'], ['-h', 'animate']]) expect(isShapeAnimateHelp(argv)).toBe(true);
    for (const argv of [['--help'], ['kit'], ['update', '--file', 'animate'], ['animate', 'kit'], ['frame', 'animate'], []]) expect(isShapeAnimateHelp(argv)).toBe(false);
  });

  // What regresses: a still board's agent never opens the animate topic, so the look and "not a
  // dashboard" must reach it through the main guide, and both texts must stay one text.
  test('the main guide carries the look and the animations section; the topic repeats the same look', () => {
    expect(SHAPE_GUIDE).toContain(SHAPE_PICTURE_LOOK);
    expect(SHAPE_GUIDE.trimEnd().endsWith(SHAPE_ANIMATIONS_SECTION.trimEnd())).toBe(true);
    expect(SHAPE_ANIMATE_HELP).toContain(SHAPE_PICTURE_LOOK);
  });
});
