/**
 * The Escape ladder of a full-screen file (escapeLadder.ts): one thing per
 * press, innermost first, full screen last. What would regress: a press that
 * leaves full screen while a menu, a composer or the drawer is still open,
 * Annotate skipped on HTML, or a kind of file whose walk never ends.
 */
import { describe, expect, test } from 'bun:test';
import { ESCAPE_LADDER, IDLE_LADDER, escapeRung, everythingOpen, rungsFor, walkLadder, type LadderFileKind } from './escapeLadder';

const KINDS: LadderFileKind[] = ['html', 'markdown', 'text', 'code', 'diagram', 'image', 'video', 'download'];

describe('the Escape ladder', () => {
  test('beside the thread there is no ladder; full screen with nothing open leaves', () => {
    expect(escapeRung({ ...IDLE_LADDER, full: false, panelOpen: true, annotating: true })).toBeNull();
    expect(escapeRung(IDLE_LADDER)).toBe('leave');
  });

  for (const kind of KINDS) {
    test(`${kind}: with everything open, each press takes the next rung in ladder order and the last leaves full screen`, () => {
      const walk = walkLadder(everythingOpen(kind));
      expect(walk).toEqual([...rungsFor(kind)]);
      expect(walk.at(-1)).toBe('leave');
      // Always in the ladder's own order.
      const order = walk.map((rung) => ESCAPE_LADDER.indexOf(rung));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  }

  test('only HTML has Annotate; only an image and a film have their own comment row', () => {
    expect(KINDS.filter((kind) => rungsFor(kind).includes('annotate'))).toEqual(['html']);
    expect(KINDS.filter((kind) => rungsFor(kind).includes('field'))).toEqual(['image', 'video']);
  });

  test('a menu closes before a composer, the drawer before Annotate, Annotate before the question, and the question before leaving', () => {
    expect(escapeRung({ ...IDLE_LADDER, popoverOpen: true, composerOpen: true })).toBe('popover');
    expect(escapeRung({ ...IDLE_LADDER, composerOpen: true, panelOpen: true })).toBe('composer');
    expect(escapeRung({ ...IDLE_LADDER, inField: true, panelOpen: true })).toBe('field');
    expect(escapeRung({ ...IDLE_LADDER, panelOpen: true, annotating: true })).toBe('drawer');
    expect(escapeRung({ ...IDLE_LADDER, annotating: true, questionOpen: true })).toBe('annotate');
    expect(escapeRung({ ...IDLE_LADDER, questionOpen: true })).toBe('question');
  });
});
