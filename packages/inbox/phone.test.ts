/**
 * The phone's keyboard rule (phone.ts keyboardLayout) and the one phone
 * query. The failures these catch: a pinch-zoom read as a keyboard (the
 * window shrinks to the zoomed viewport and jumps back to the corner on every
 * pan), and inbox.css's phone block drifting from PHONE_QUERY.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHONE_QUERY, keyboardLayout } from './phone';

describe('the keyboard on a phone', () => {
  test('the keyboard up, unzoomed: the window takes the height above it and undoes the pan', () => {
    expect(keyboardLayout({ height: 400, offsetTop: 120, scale: 1 }, 659, 0, true)).toEqual({ height: 400, resetScroll: true });
    expect(keyboardLayout({ height: 400.4, offsetTop: 0, scale: 1 }, 659, 0, true)).toEqual({ height: 400, resetScroll: false });
  });

  test('pinch-zoomed to 2x: never read as a keyboard, and never scrolled back', () => {
    // At scale 2 the visual viewport is half the window, panned anywhere.
    expect(keyboardLayout({ height: 329.5, offsetTop: 200, scale: 2 }, 659, 0, true)).toEqual({ height: null, resetScroll: false });
    // Zoomed with the keyboard up too: left alone until the zoom is undone.
    expect(keyboardLayout({ height: 200, offsetTop: 120, scale: 2 }, 659, 40, true)).toEqual({ height: null, resetScroll: false });
  });

  test('nothing on a desktop window, or with nothing covering the bottom', () => {
    expect(keyboardLayout({ height: 400, offsetTop: 0, scale: 1 }, 659, 0, false)).toEqual({ height: null, resetScroll: false });
    expect(keyboardLayout({ height: 640, offsetTop: 0, scale: 1 }, 659, 0, true)).toEqual({ height: null, resetScroll: false });
  });
});

test("inbox.css spells PHONE_QUERY in its phone block, and no other phone break", () => {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  expect(css).toContain(`@media ${PHONE_QUERY} {`);
  // A phone rule elsewhere must use the same query, not a width of its own.
  expect(css).not.toMatch(/@media \(max-width: 767px\) \{/);
});
