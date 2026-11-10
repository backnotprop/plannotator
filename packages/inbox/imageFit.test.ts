/**
 * How a picture in a message body is sized (approval "inbox-inline-image-fit", 2026-11-10): whole, inside the
 * column and 70% of the window's height (never under 320 px), never drawn larger than its file; only a picture
 * more than three times as tall as wide is cut, to its top. inbox.css draws the same numbers from
 * `--ib-nw` / `--ib-nh`; the browser proof is tests/e2e/inbox-worst-case.spec.ts.
 */
import { expect, test } from 'bun:test';
import { fitMessageImage, messageImageCap } from './images';

const WINDOW = { width: 2880, height: 1800 };
const PHONE = { width: 1170, height: 2532 };
const CROP = { width: 300, height: 120 };
const SHEET = { width: 3000, height: 600 };
const PAGE = { width: 800, height: 4000 };
const CHART = { width: 1200, height: 800 };
const ICON = { width: 48, height: 48 };

const drawn = (size: { width: number; height: number }, column: number, windowHeight: number) => {
  const fit = fitMessageImage(size, column, windowHeight);
  return { width: Math.round(fit.width), height: Math.round(fit.height), cut: fit.cut };
};

test('the cap is 70% of the window, never under 320 px', () => {
  expect(messageImageCap(1000)).toBe(700);
  expect(messageImageCap(390)).toBe(320);
});

test('a wide picture fills the column and keeps its shape; the height cap takes over in a wide pane', () => {
  expect(drawn(WINDOW, 520, 900)).toEqual({ width: 520, height: 325, cut: false });
  expect(drawn(WINDOW, 900, 900)).toEqual({ width: 900, height: 563, cut: false });
  // 1400 wide would be 875 high: the cap (630) draws it 1008 wide instead.
  expect(drawn(WINDOW, 1400, 900)).toEqual({ width: 1008, height: 630, cut: false });
  expect(drawn(CHART, 900, 900)).toEqual({ width: 900, height: 600, cut: false });
  expect(drawn(SHEET, 520, 900)).toEqual({ width: 520, height: 104, cut: false });
  expect(drawn(SHEET, 1400, 900)).toEqual({ width: 1400, height: 280, cut: false });
});

test('a phone-shaped picture is drawn whole at the cap, not cut and not blown up to the column', () => {
  expect(drawn(PHONE, 900, 900)).toEqual({ width: 291, height: 630, cut: false });
  expect(drawn(PHONE, 520, 1200)).toEqual({ width: 388, height: 840, cut: false });
  // A phone's column, a phone's window: 70% of 844.
  expect(drawn(PHONE, 358, 844)).toEqual({ width: 273, height: 591, cut: false });
  // A short window: the 320 px floor, not 70% of 400.
  expect(drawn(PHONE, 900, 400)).toEqual({ width: 148, height: 320, cut: false });
});

test('a small picture stays its own size at every width', () => {
  for (const column of [358, 520, 900, 1400]) {
    expect(drawn(CROP, column, 900)).toEqual({ width: 300, height: 120, cut: false });
    expect(drawn(ICON, column, 900)).toEqual({ width: 48, height: 48, cut: false });
  }
  // Narrower than the picture: the column wins, the shape stays.
  expect(drawn(CROP, 150, 900)).toEqual({ width: 150, height: 60, cut: false });
});

test('only a picture more than three times as tall as wide is cut: column width, its top, down to the cap', () => {
  expect(drawn(PAGE, 900, 900)).toEqual({ width: 800, height: 630, cut: true });
  expect(drawn(PAGE, 520, 900)).toEqual({ width: 520, height: 630, cut: true });
  expect(drawn(PAGE, 358, 844)).toEqual({ width: 358, height: 591, cut: true });
  // Exactly three times as tall is not "more than": whole, at the cap.
  expect(drawn({ width: 400, height: 1200 }, 900, 900)).toEqual({ width: 210, height: 630, cut: false });
  // Long but short enough to fit under the cap: whole, at its own size, nothing to show.
  expect(drawn({ width: 100, height: 400 }, 900, 900)).toEqual({ width: 100, height: 400, cut: false });
});

test('nothing is ever drawn larger than its file or wider than the column', () => {
  for (const size of [WINDOW, PHONE, CROP, SHEET, PAGE, CHART, ICON]) {
    for (const column of [358, 520, 900, 1400]) {
      for (const windowHeight of [400, 844, 900, 1400]) {
        const fit = fitMessageImage(size, column, windowHeight);
        expect(fit.width).toBeLessThanOrEqual(Math.min(column, size.width) + 0.001);
        expect(fit.height).toBeLessThanOrEqual(messageImageCap(windowHeight) + 0.001);
        if (!fit.cut) expect(fit.width / fit.height).toBeCloseTo(size.width / size.height, 6);
      }
    }
  }
});
