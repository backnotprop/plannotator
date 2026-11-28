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

const pictures = [...page.matchAll(/<img\b[^>]*\bsrc="(\/assets\/spaces\/img\/[^"/?]+\.png)(\?[^"]*)?"[^>]*>/g)].map(([tag, src, query]) => ({
  src,
  version: Number(new URLSearchParams(query ?? '').get('v') ?? 0),
  width: Number(/\bwidth="(\d+)"/.exec(tag)?.[1]),
  height: Number(/\bheight="(\d+)"/.exec(tag)?.[1]),
}));

// Pictures retaken when the made-up space became Field notes. The files keep
// their names, so a browser holding the old picture (the old name) would show
// it beside the new text; a new version in the address makes it fetch again.
// Each name maps to the lowest version its address may ask for: `whole` was
// retaken again later, so it needs a version past the first retake's.
const RETAKEN = Object.entries({ whole: 3, clone: 2, 'clone-c': 2, prt2: 2, 'pr-c': 2 }).flatMap(([name, version]) => [
  { file: `${name}-l.png`, version },
  { file: `${name}-d.png`, version },
]);

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

  test('every retaken picture is asked for at a new address, so no browser reuses the old one', () => {
    for (const { file, version } of RETAKEN) {
      const uses = pictures.filter((picture) => picture.src.endsWith(`/${file}`));
      expect(uses.length, file).toBeGreaterThan(0);
      for (const use of uses) expect(use.version, file).toBeGreaterThanOrEqual(version);
    }
  });
});
