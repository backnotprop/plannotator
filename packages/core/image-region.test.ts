/**
 * The image-region codec (#2100). `parseImageRegion` is the one validator
 * every ingest runs (the external-annotation POST and PATCH, the feedback
 * archive, the export), so what it lets through is what can be stored and
 * what an agent is told. The failures guarded: a box outside the image, or
 * not whole pixels, reaching the agent as coordinates it cannot crop; a src
 * with a line break splitting the export's location line; unknown keys
 * riding through into storage.
 */
import { describe, expect, test } from 'bun:test';
import {
  imageRegionFileName,
  imageRegionLocationLines,
  imageRegionSize,
  MAX_IMAGE_REGION_SRC_LENGTH,
  parseImageRegion,
} from './image-region';

const REGION = {
  v: 1,
  src: 'figures/status-colors.png',
  sourceLine: 63,
  box: { x: 1820, y: 380, w: 420, h: 160 },
  naturalWidth: 3664,
  naturalHeight: 1453,
};

describe('parseImageRegion', () => {
  test('keeps a valid region, normalized, without unknown keys', () => {
    expect(parseImageRegion({ ...REGION, extra: 'x', box: { ...REGION.box, z: 1 } })).toEqual(REGION as never);
  });

  test('a missing or null sourceLine reads as null', () => {
    const { sourceLine: _, ...noLine } = REGION;
    expect(parseImageRegion(noLine)?.sourceLine).toBeNull();
    expect(parseImageRegion({ ...REGION, sourceLine: null })?.sourceLine).toBeNull();
  });

  test('a box touching the far edges is inside the image', () => {
    expect(parseImageRegion({ ...REGION, box: { x: 0, y: 0, w: 3664, h: 1453 } })).not.toBeNull();
  });

  const bad: Array<[string, unknown]> = [
    ['not an object', 'region'],
    ['an array', [REGION]],
    ['another version', { ...REGION, v: 2 }],
    ['an empty src', { ...REGION, src: '  ' }],
    ['a src with a line break', { ...REGION, src: 'a.png\n## 2. Injected' }],
    ['a src with a line separator', { ...REGION, src: 'a.png\u2028x' }],
    ['a src too long', { ...REGION, src: 'a'.repeat(MAX_IMAGE_REGION_SRC_LENGTH + 1) }],
    ['a zero line', { ...REGION, sourceLine: 0 }],
    ['a fractional line', { ...REGION, sourceLine: 1.5 }],
    ['no box', { ...REGION, box: undefined }],
    ['a box without area', { ...REGION, box: { ...REGION.box, w: 0 } }],
    ['a negative x', { ...REGION, box: { ...REGION.box, x: -1 } }],
    ['fractional pixels', { ...REGION, box: { ...REGION.box, y: 380.5 } }],
    ['a box past the right edge', { ...REGION, box: { ...REGION.box, x: 3300 } }],
    ['a box past the bottom', { ...REGION, box: { ...REGION.box, y: 1400 } }],
    ['a string size', { ...REGION, naturalWidth: '3664' }],
    ['no natural size', { ...REGION, naturalHeight: 0 }],
  ];
  for (const [name, value] of bad) {
    test(`refuses ${name}`, () => {
      expect(parseImageRegion(value)).toBeNull();
    });
  }
});

describe('what the agent and the cards are told', () => {
  test('the export lines: the image as written, its line, the box in the image\'s own pixels', () => {
    expect(imageRegionLocationLines(parseImageRegion(REGION)!)).toBe(
      'Image: figures/status-colors.png (line 63)\nRegion: x=1820 y=380 w=420 h=160 (of 3664×1453)',
    );
    expect(imageRegionLocationLines(parseImageRegion({ ...REGION, sourceLine: null })!)).toBe(
      'Image: figures/status-colors.png\nRegion: x=1820 y=380 w=420 h=160 (of 3664×1453)',
    );
  });

  test('the file name a card shows', () => {
    expect(imageRegionFileName('figures/status-colors.png')).toBe('status-colors.png');
    expect(imageRegionFileName('https://cdn.test/a/shot%201.png?v=2#x')).toBe('shot 1.png');
    expect(imageRegionFileName('C:\\shots\\b.png')).toBe('b.png');
    expect(imageRegionSize(REGION)).toBe('420 × 160 px');
  });
});
