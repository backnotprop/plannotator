import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Spaces page's app pictures (the PNGs directly in /assets/spaces/img/;
// logos live in subfolders) are retaken from the app now and then. A retaken
// picture with a new pixel size, left with the old width and height in the
// markup, is drawn stretched. Its markup size must keep its proportions, to
// within the rounding of a whole CSS pixel.
const here = import.meta.dir;
const page = readFileSync(join(here, 'src/pages/workspaces/index.astro'), 'utf8');

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('latin1'), file).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const pictures = [...page.matchAll(/<img\b[^>]*\bsrc="(\/assets\/spaces\/img\/[^"/]+\.png)"[^>]*>/g)].map(([tag, src]) => ({
  src,
  width: Number(/\bwidth="(\d+)"/.exec(tag)?.[1]),
  height: Number(/\bheight="(\d+)"/.exec(tag)?.[1]),
}));

describe('the Spaces page app pictures', () => {
  test('the page has app pictures to check', () => {
    expect(pictures.length).toBeGreaterThan(0);
  });

  for (const picture of pictures) {
    test(`${picture.src}: the markup width and height keep the picture's proportions`, () => {
      const pixels = pngSize(join(here, 'public', picture.src));
      const height = (picture.width * pixels.height) / pixels.width;
      expect(Math.abs(picture.height - height), `${picture.width}x${picture.height} for ${pixels.width}x${pixels.height}`).toBeLessThanOrEqual(1);
    });
  }
});
