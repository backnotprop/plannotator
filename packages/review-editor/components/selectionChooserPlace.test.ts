import { describe, expect, test } from 'bun:test';
import { placeChooser } from './selectionChooserPlace';

const bounds = { top: 0, bottom: 900, left: 0, right: 1440 };
const bar = { width: 220, height: 28 };

const clear = (place: { top: number }, lines: { top: number; bottom: number }) => place.top + bar.height <= lines.top || place.top >= lines.bottom;

describe('placeChooser', () => {
  test('under the last line, at the start of its code, when there is room', () => {
    const lines = { top: 300, bottom: 360, left: 803 };
    expect(placeChooser(lines, bar, bounds)).toEqual({ top: 366, left: 803 });
  });

  test('never over the lines where there is room, wherever they are on the screen', () => {
    for (let top = 8 + 28 + 6; top + 60 + 6 + 28 + 8 < 900; top += 20) {
      const lines = { top, bottom: top + 60, left: 100 };
      const place = placeChooser(lines, bar, bounds);
      expect(clear(place, lines)).toBe(true);
    }
  });

  test('exactly enough room below stays below; a pixel less goes above', () => {
    expect(placeChooser({ top: 800, bottom: 858, left: 100 }, bar, bounds).top).toBe(864);
    expect(placeChooser({ top: 800, bottom: 859, left: 100 }, bar, bounds).top).toBe(766);
  });

  test('no room below or above: on screen at the bottom edge', () => {
    expect(placeChooser({ top: 10, bottom: 890, left: 100 }, bar, bounds).top).toBe(864);
  });

  test('exactly enough room above goes above; a pixel less takes the bottom edge', () => {
    expect(placeChooser({ top: 42, bottom: 880, left: 100 }, bar, bounds).top).toBe(8);
    expect(placeChooser({ top: 41, bottom: 880, left: 100 }, bar, bounds).top).toBe(864);
  });

  test('lines scrolled off either end: the bar stays on screen', () => {
    expect(placeChooser({ top: -300, bottom: -200, left: 100 }, bar, bounds).top).toBe(8);
    expect(placeChooser({ top: 1200, bottom: 1300, left: 100 }, bar, bounds).top).toBe(864);
  });

  test('never off the sides', () => {
    expect(placeChooser({ top: 100, bottom: 120, left: 1400 }, bar, bounds).left).toBe(1212);
    expect(placeChooser({ top: 100, bottom: 120, left: -30 }, bar, bounds).left).toBe(8);
  });

  test('the visible viewport, not the window: a phone keyboard or a shifted viewport moves the limits', () => {
    const phone = { top: 16, bottom: 416, left: 16, right: 374 };
    const tall = { width: 230, height: 44 };
    expect(placeChooser({ top: 300, bottom: 358, left: 40 }, tall, phone).top).toBe(364);
    expect(placeChooser({ top: 300, bottom: 359, left: 40 }, tall, phone).top).toBe(250);
    expect(placeChooser({ top: 300, bottom: 320, left: 300 }, tall, phone).left).toBe(136);
  });

  test('a viewport too small for the bar keeps its top and left on screen', () => {
    const tiny = { top: 0, bottom: 30, left: 0, right: 100 };
    expect(placeChooser({ top: 5, bottom: 25, left: 50 }, bar, tiny)).toEqual({ top: 8, left: 8 });
  });
});
