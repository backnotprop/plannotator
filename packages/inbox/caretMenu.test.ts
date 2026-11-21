/**
 * The box the compose picker hangs off (caretMenu.ts caretAnchor): the
 * caret's line, held inside the part of the field that is on screen, so a
 * field scrolled past the caret keeps the picker beside the field instead of
 * floating over the To line or the footer.
 */
import { describe, expect, test } from 'bun:test';
import { caretAnchor, phoneSkillListHeight, seenBox } from './caretMenu';

const field = { left: 40, width: 600 };

describe('caretAnchor', () => {
  test('the caret line as it is when it is in view, across the field', () => {
    expect(caretAnchor({ top: 300, bottom: 324 }, { top: 250, bottom: 570 }, field)).toEqual({ top: 300, bottom: 324, left: 40, width: 600 });
  });

  test('a line scrolled above the visible field pins to its top edge', () => {
    expect(caretAnchor({ top: 120, bottom: 144 }, { top: 250, bottom: 570 }, field)).toEqual({ top: 250, bottom: 274, left: 40, width: 600 });
  });

  test('a line scrolled below the visible field pins to its bottom edge', () => {
    expect(caretAnchor({ top: 700, bottom: 724 }, { top: 250, bottom: 570 }, field)).toEqual({ top: 546, bottom: 570, left: 40, width: 600 });
  });

  test('a visible area shorter than a line never yields a box past it', () => {
    const box = caretAnchor({ top: 300, bottom: 324 }, { top: 250, bottom: 260 }, field);
    expect(box.top).toBe(250);
    expect(box.bottom).toBe(260);
  });
});

describe('seenBox', () => {
  const view = (vv: { height: number; offsetTop: number } | null, innerHeight: number) =>
    ({ visualViewport: vv, innerHeight, document: { documentElement: { clientHeight: 640 } } }) as unknown as Window;

  test('the visual viewport, not the layout viewport: under the iOS keyboard innerHeight still reads the full height', () => {
    expect(seenBox(view({ height: 257, offsetTop: 0 }, 660))).toEqual({ top: 0, bottom: 257 });
    expect(seenBox(view({ height: 257, offsetTop: 40 }, 660))).toEqual({ top: 40, bottom: 297 });
  });

  test('a reading caught mid-rotation (NaN) falls back to a real height, never NaN (NaN re-rendered the list forever)', () => {
    expect(seenBox(view({ height: Number.NaN, offsetTop: 0 }, 660))).toEqual({ top: 0, bottom: 660 });
    expect(seenBox(view({ height: Number.NaN, offsetTop: 0 }, Number.NaN))).toEqual({ top: 0, bottom: 640 });
  });
});

describe('phoneSkillListHeight', () => {
  test('4½ rows at most, 40% of what shows, never under 1½ rows', () => {
    expect(phoneSkillListHeight(800)).toBe(198);
    expect(phoneSkillListHeight(257)).toBe(103);
    expect(phoneSkillListHeight(140)).toBe(66);
  });
});
