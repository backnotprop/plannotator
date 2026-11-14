import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { fittedSize, pictureKind, shrinksPicture } from './fitPicture';
import { PICTURE_MAX_BYTES } from '../projectPictures';

const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
const png = (...chunks: number[][]) => bytes([0x89], 'PNG\r\n\x1a\n', ...chunks);
const IHDR = chunk('IHDR', [...u32(16), ...u32(16), 8, 6, 0, 0, 0]);
const IDAT = chunk('IDAT', [...deflateSync(new Uint8Array(17))]);
const over = PICTURE_MAX_BYTES + 1;

describe('a big picture: shrunk or kept as it is', () => {
  test('a phone photo (JPEG, HEIC), a still PNG or WebP over the limit is shrunk; under it, nothing is', () => {
    expect(shrinksPicture(pictureKind(bytes([0xff, 0xd8, 0xff, 0xe1])), over)).toBe(true);
    expect(shrinksPicture(pictureKind(bytes([0, 0, 0, 0x18], 'ftypheic')), over)).toBe(true);
    expect(shrinksPicture(pictureKind(png(IHDR, IDAT)), over)).toBe(true);
    expect(shrinksPicture(pictureKind(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), over)).toBe(true);
    expect(shrinksPicture(pictureKind(bytes([0xff, 0xd8, 0xff, 0xe1])), PICTURE_MAX_BYTES)).toBe(false);
  });

  test('anything that moves, and an SVG, is never redrawn: an animated PNG (acTL before the picture), an animated WebP, a GIF', () => {
    expect(pictureKind(png(IHDR, chunk('acTL', [...u32(4), ...u32(0)]), IDAT))).toBe('apng');
    expect(pictureKind(png(IHDR, IDAT, chunk('acTL', [...u32(4), ...u32(0)])))).toBe('png');
    expect(pictureKind(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8X', [0, 0, 0, 0], [0x02]))).toBe('webp-animated');
    for (const kind of ['apng', 'webp-animated', 'gif', 'svg'] as const) expect(shrinksPicture(kind, over * 4)).toBe(false);
    expect(pictureKind(bytes('GIF89a'))).toBe('gif');
    expect(pictureKind(bytes('  <svg xmlns="http://www.w3.org/2000/svg">'))).toBe('svg');
  });

  test('its own proportions, the longest side 256, never made larger', () => {
    expect(fittedSize(4032, 3024)).toEqual({ width: 256, height: 192 });
    expect(fittedSize(3024, 4032)).toEqual({ width: 192, height: 256 });
    expect(fittedSize(4000, 1000)).toEqual({ width: 256, height: 64 });
    expect(fittedSize(200, 120)).toEqual({ width: 200, height: 120 });
  });
});
