/**
 * Where the Swarm first-time note stands on a computer (swarmTipPlace.ts). What this catches: the note hung under the
 * badge again where it lies over the message box (the badge is at the right end of New message's To row, the dialog's
 * top row), or put beside or above where it would leave the window. Boxes are the ones measured in a 1440×900 and a
 * 1280×800 window (the dialog's default place), and a short one.
 */
import { expect, test } from 'bun:test';
import { swarmTipSide } from './swarmTipPlace';

const NOTE = { width: 184, height: 97 };

test('the usual windows: beside the badge, right of the dialog, level with To; the draft-saved badge further left too', () => {
  expect(swarmTipSide({ badge: { left: 965, right: 1046, top: 119, bottom: 145 }, note: NOTE, window: { width: 1440, height: 900 } })).toBe('right');
  expect(swarmTipSide({ badge: { left: 885, right: 966, top: 107, bottom: 133 }, note: NOTE, window: { width: 1280, height: 800 } })).toBe('right');
  expect(swarmTipSide({ badge: { left: 820, right: 901, top: 119, bottom: 145 }, note: NOTE, window: { width: 1440, height: 900 } })).toBe('right');
  // A short window: the dialog sits 16 px from the top, and beside still fits.
  expect(swarmTipSide({ badge: { left: 885, right: 966, top: 27, bottom: 53 }, note: NOTE, window: { width: 1280, height: 400 } })).toBe('right');
});

test('no room beside: over the badge when that fits, else under it, never outside the window', () => {
  // A narrow window (the dialog fills it): no room right; the dialog lower down leaves room above.
  expect(swarmTipSide({ badge: { left: 620, right: 701, top: 140, bottom: 166 }, note: NOTE, window: { width: 732, height: 1000 } })).toBe('above');
  // Neither: the old place.
  expect(swarmTipSide({ badge: { left: 620, right: 701, top: 40, bottom: 66 }, note: NOTE, window: { width: 732, height: 600 } })).toBe('below');
  // Beside would run past the window's right edge by a pixel.
  expect(swarmTipSide({ badge: { left: 1100, right: 1206, top: 140, bottom: 166 }, note: NOTE, window: { width: 1411, height: 900 } })).toBe('above');
});
