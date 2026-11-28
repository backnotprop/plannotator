import { describe, expect, test } from 'bun:test';
import { svgDimensions } from '@plannotator/shared/review-image';
import { imagePreviewHeight } from './previewHeight';

const svg = (source: string) => {
  const size = svgDimensions(new TextEncoder().encode(source));
  return { bytes: source.length, width: size.width, height: size.height };
};

const base = { width: 900, mode: 'side' as const, zoom: 'fit' as const, dpr: 2 };

describe('the reserved height of an SVG preview matches what it draws', () => {
  test('an SVG with its own width and height: one row, labels above the 64 px box, one caption line', () => {
    const icon = svg('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"></svg>');
    expect(imagePreviewHeight({ ...base, status: 'modified', sizes: { old: icon, new: icon } })).toBe(25 + 24 + 64 + 24);
  });

  test('an SVG with only a viewBox takes the viewBox size, then the tiny-image rule', () => {
    const glyph = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect/></svg>');
    expect(glyph).toMatchObject({ width: 24, height: 24 });
    expect(imagePreviewHeight({ ...base, status: 'modified', sizes: { old: glyph, new: glyph } })).toBe(25 + 24 + 72 + 24);
  });

  test('an SVG with no size at all is the browser default 300 x 150', () => {
    const bare = svg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    expect(bare).toMatchObject({ width: 300, height: 150 });
    expect(imagePreviewHeight({ ...base, status: 'added', sizes: { new: bare } })).toBe(25 + 24 + 150 + 24);
  });

  test('a size known only in percent falls back to the default rather than to nothing', () => {
    expect(svg('<svg width="100%" height="100%"></svg>')).toMatchObject({ width: 300, height: 150 });
  });
});
