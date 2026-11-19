import { describe, expect, test } from 'bun:test';
import { groundUnder, lookOfPixels } from './picture-look';

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
