import { describe, expect, test } from 'bun:test';
import { groundUnder, lookOfPixels, pictureLooks, rememberLook } from './picture-look';

/** A 24 by 24 picture from a rule for each cell: [r, g, b, a]. */
function pixels(at: (col: number, row: number) => [number, number, number, number]): number[] {
  const out: number[] = [];
  for (let row = 0; row < 24; row++) for (let col = 0; col < 24; col++) out.push(...at(col, row));
  return out;
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

describe('what words and lines over a picture are read against', () => {
  test('a pale picture is a light ground and a dark one a dark ground, whatever the board is', () => {
    const box = { x: 0, y: 0, w: 240, h: 240 };
    expect(groundUnder(lookOfPixels(pixels(() => WHITE), 1), box, { x: 20, y: 20, w: 100, h: 30 })).toBe('light');
    expect(groundUnder(lookOfPixels(pixels(() => BLACK), 1), box, { x: 20, y: 20, w: 100, h: 30 })).toBe('dark');
    // The line between them is where dark ink stops being read at 4.5 to 1: mid grey (#777) is light, #555 is dark.
    expect(groundUnder(lookOfPixels(pixels(() => [119, 119, 119, 255]), 1), box, box)).toBe('light');
    expect(groundUnder(lookOfPixels(pixels(() => [85, 85, 85, 255]), 1), box, box)).toBe('dark');
  });

  test('it is the part of the picture under the mark that counts, not the whole picture', () => {
    // Dark on the left half, light on the right.
    const look = lookOfPixels(pixels((col) => (col < 12 ? BLACK : WHITE)), 1);
    const box = { x: 1000, y: 500, w: 480, h: 480 };
    expect(groundUnder(look, box, { x: 1020, y: 700, w: 100, h: 30 })).toBe('dark');
    expect(groundUnder(look, box, { x: 1340, y: 700, w: 100, h: 30 })).toBe('light');
  });

  test('a picture narrower than its box sits in the middle of it, and the mark is placed on the picture itself', () => {
    // Twice as tall as wide, in a square box: it fills the middle half. Its own left half is dark.
    const look = lookOfPixels(pixels((col) => (col < 12 ? BLACK : WHITE)), 0.5);
    const box = { x: 0, y: 0, w: 400, h: 400 };
    expect(groundUnder(look, box, { x: 110, y: 100, w: 60, h: 20 })).toBe('dark');
    expect(groundUnder(look, box, { x: 230, y: 100, w: 60, h: 20 })).toBe('light');
  });

  test('a see-through part counts as light, the ground such a picture is given, and marks it as having clear parts', () => {
    const look = lookOfPixels(pixels(() => [0, 0, 0, 0]), 1);
    expect(look.clear).toBe(true);
    expect(groundUnder(look, { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 })).toBe('light');
    expect(lookOfPixels(pixels(() => BLACK), 1).clear).toBe(false);
  });

  test('a picture that could not be looked at says so, and nothing given breaks it', () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    expect(groundUnder(null, box, box)).toBe('picture');
    expect(groundUnder(undefined, box, box)).toBe('picture');
    const look = lookOfPixels(pixels(() => WHITE), Number.NaN);
    expect(look.aspect).toBe(1);
    // A mark that hangs off the picture, a box with no size, and too few pixels: an answer, never a throw.
    expect(groundUnder(look, box, { x: -500, y: -500, w: 10, h: 10 })).toBe('light');
    expect(groundUnder(look, { x: 0, y: 0, w: 0, h: 0 }, box)).toBe('light');
    expect(groundUnder(lookOfPixels([], 1), box, box)).toBe('dark');
    expect(groundUnder(lookOfPixels(pixels(() => BLACK), 0), box, { x: 1e9, y: -1e9, w: Number.NaN, h: 1 })).toBe('dark');
  });
});

describe('hearing that a picture has been looked at', () => {
  const look = lookOfPixels(pixels(() => WHITE), 1);
  const settle = () => new Promise<void>((resolve) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => resolve()) : queueMicrotask(resolve)));

  test('only what waits on that picture hears, once, however many pictures load together', async () => {
    let mine = 0;
    let other = 0;
    const stop = pictureLooks.subscribe('look-test/a.png', () => (mine += 1));
    const stopOther = pictureLooks.subscribe('look-test/never.png', () => (other += 1));
    // A hundred pictures finish loading, each in a task of its own; one of them is the one waited on, told twice.
    for (let i = 0; i < 100; i++) rememberLook(`look-test/p${i}.png`, look);
    rememberLook('look-test/a.png', look);
    rememberLook('look-test/a.png', look);
    expect(mine).toBe(0);
    await settle();
    expect(mine).toBe(1);
    expect(other).toBe(0);
    expect(pictureLooks.get('look-test/a.png')).toBe(look);
    stop();
    stopOther();
    rememberLook('look-test/a.png', null);
    await settle();
    expect(mine).toBe(1);
  });

  test('past what is remembered, the picture looked at longest ago is forgotten, never the ones just seen', () => {
    rememberLook('look-test/first.png', look);
    for (let i = 0; i < 2100; i++) rememberLook(`look-test/many${i}.png`, look);
    expect(pictureLooks.get('look-test/first.png')).toBeUndefined();
    expect(pictureLooks.get('look-test/many2099.png')).toBe(look);
    expect(pictureLooks.get('look-test/many500.png')).toBe(look);
    // Looked at again, it is among the newest.
    rememberLook('look-test/many101.png', look);
    for (let i = 0; i < 1900; i++) rememberLook(`look-test/more${i}.png`, look);
    expect(pictureLooks.get('look-test/many101.png')).toBe(look);
    expect(pictureLooks.get('look-test/many500.png')).toBeUndefined();
  });
});
