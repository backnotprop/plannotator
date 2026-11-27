/**
 * The side chat corner's cut (scoop.ts). Failures to catch: the panes' real shadow tokens misread (a colour split at
 * the commas inside color-mix, the hairline taken for a shadow, the dark inset highlight lost), so the edge layers
 * would draw the wrong shadow along the cut; the 28 px geometry no longer cutting a notch at the 8 px gutter; and the
 * button's hit area reaching past the pocket into the pane, where Send and the bin are.
 */
import { expect, test } from 'bun:test';
import { SIDE_CORNER, SIDE_CORNER_HIT, SIDE_CORNER_R, isRingShadow, parseBoxShadows, scoopFits, scoopMask, sideCornerHitPath } from './scoop';

test("the panes' shadow tokens, light and dark, read into a hairline, the soft shadows and the inset highlight", () => {
  // As the browser resolves --ib-pane-shadow (inbox.css), variables substituted, color-mix kept.
  const light = parseBoxShadows(
    '0 0 0 1px color-mix(in oklch, oklch(0.88 0.01 260) 55%, transparent), 0 1px 2px color-mix(in oklch, oklch(0.18 0.02 260) 5%, transparent), 0 6px 18px -8px color-mix(in oklch, oklch(0.18 0.02 260) 12%, transparent)',
  );
  expect(light.map((s) => [s.x, s.y, s.blur, s.spread, s.inset])).toEqual([
    [0, 0, 0, 1, false],
    [0, 1, 2, 0, false],
    [0, 6, 18, -8, false],
  ]);
  expect(light[0]!.color).toBe('color-mix(in oklch, oklch(0.88 0.01 260) 55%, transparent)');
  expect(light.map(isRingShadow)).toEqual([true, false, false]);
  const dark = parseBoxShadows('0 0 0 1px color-mix(in oklch, oklch(0.97 0 0) 6%, transparent), inset 0 1px 0 color-mix(in oklch, oklch(0.97 0 0) 4%, transparent), 0 8px 24px -10px rgb(0 0 0 / 0.6)');
  expect(dark.map((s) => [s.y, s.blur, s.spread, s.inset])).toEqual([
    [0, 0, 1, false],
    [1, 0, 0, true],
    [8, 24, -10, false],
  ]);
  expect(dark[2]!.color).toBe('rgb(0 0 0 / 0.6)');
  // A computed value puts the colour first.
  expect(parseBoxShadows('rgba(0, 0, 0, 0.1) 0px 4px 12px 0px')[0]).toEqual({ x: 0, y: 4, blur: 12, spread: 0, color: 'rgba(0, 0, 0, 0.1)', inset: false });
  expect(parseBoxShadows('none')).toEqual([]);
});

test('the 28 px circle cuts a notch in a pane 8 px from the window corner, and none in a pane out of its reach or flush with the window', () => {
  expect(SIDE_CORNER_R).toBe(19);
  expect(scoopFits({ sx: SIDE_CORNER_R - 8, sy: SIDE_CORNER_R - 8, R: SIDE_CORNER_R, f: SIDE_CORNER.f })).toBe(true);
  // Every layer's shape (the pane, its rim grown by 1, a shadow's source eroded by 10) builds.
  for (const grow of [0, 1, -8, -10]) expect(() => scoopMask({ sx: 11, sy: 11, R: 19, f: 5 }, grow)).not.toThrow();
  // A pane whose corner is past the pocket's reach is not cut.
  expect(scoopFits({ sx: SIDE_CORNER_R - 30, sy: SIDE_CORNER_R - 30, R: SIDE_CORNER_R, f: SIDE_CORNER.f })).toBe(false);
  // Flush with the window's edges (no gutter): the pocket would be a hole touching them, so the circle sits over it.
  expect(scoopFits({ sx: SIDE_CORNER_R, sy: SIDE_CORNER_R, R: SIDE_CORNER_R, f: SIDE_CORNER.f })).toBe(false);
});

/** Is (x, y) inside the hit path? The path's pieces, read back: the pocket's disc and the two edge strips. */
function hits(path: string, x: number, y: number): boolean {
  const disc = path.match(/^M([\d.]+) ([\d.]+)A([\d.]+)/)!;
  const r = Number(disc[3]);
  const cx = Number(disc[1]) + r;
  const cy = Number(disc[2]);
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  for (const m of path.matchAll(/M([\d.]+) ([\d.]+)H([\d.]+)V([\d.]+)H([\d.]+)Z/g)) {
    const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) return true;
  }
  return false;
}

test("the button's hit area is the pocket and the ground along the window's edges, never the pane beside it", () => {
  const path = sideCornerHitPath(8, 8);
  const B = SIDE_CORNER_HIT;
  // The circle's centre, the window's very corner, and the ground along each edge out to 44 px.
  expect(hits(path, B - 19, B - 19)).toBe(true);
  expect(hits(path, B - 1, B - 1)).toBe(true);
  expect(hits(path, 1, B - 2)).toBe(true);
  expect(hits(path, B - 2, 1)).toBe(true);
  // The pane outside the pocket: the box's top-left, where the reply box's empty corner and the bin's edge can be.
  expect(hits(path, 2, 2)).toBe(false);
  expect(hits(path, 6, B - 12)).toBe(false);
  expect(hits(path, B - 12, 6)).toBe(false);
});
