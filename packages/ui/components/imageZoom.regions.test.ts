/**
 * Region boxes (#2100): a box drawn on the image is stored in the image's own
 * pixels, so it must be the same box whatever zoom and pan it was drawn at,
 * cover what was drawn (never shrink it to nothing at a high zoom), stay
 * inside the image, and come back to the same place on screen. Zooming to a
 * box must put it in view.
 */
import { describe, expect, test } from 'bun:test';
import {
  naturalBoxFromPoints,
  naturalBoxToStage,
  stageToNatural,
  viewportForBox,
  visibleNaturalBox,
  zoomLimits,
  type ZoomViewport,
} from './imageZoom';

const IMAGE = { width: 3664, height: 1453 };
const STAGE = { width: 1200, height: 700 };

describe('stage pixels to the image\'s own pixels', () => {
  // The same image pixel (1820, 380) to (2240, 540), drawn at three zooms and pans.
  const views: Array<[string, ZoomViewport]> = [
    ['Fit (about 33%)', { x: 0, y: 108.0, scale: 1200 / 3664 }],
    ['Actual size, panned', { x: -1500, y: -200, scale: 1 }],
    ['400%, panned far', { x: -7000, y: -1300, scale: 4 }],
  ];
  for (const [name, view] of views) {
    test(`at ${name} the same drag gives the same box`, () => {
      const a = { x: view.x + 1820 * view.scale, y: view.y + 380 * view.scale };
      const b = { x: view.x + 2240 * view.scale, y: view.y + 540 * view.scale };
      const box = naturalBoxFromPoints(view, a, b, IMAGE)!;
      expect(box).toEqual({ x: 1820, y: 380, w: 420, h: 160 });
      // Dragging the other way gives the same box.
      expect(naturalBoxFromPoints(view, b, a, IMAGE)).toEqual(box);
      // And it comes back to where it was drawn.
      const rect = naturalBoxToStage(view, box);
      expect(rect.left).toBeCloseTo(a.x, 6);
      expect(rect.top).toBeCloseTo(a.y, 6);
      expect(rect.left + rect.width).toBeCloseTo(b.x, 6);
      expect(rect.top + rect.height).toBeCloseTo(b.y, 6);
    });
  }

  test('a box widens to whole pixels so it always covers what was drawn', () => {
    const view = { x: 0, y: 0, scale: 8 };
    // From image pixel 10.5 to 12.25: covers pixels 10, 11 and 12.
    expect(naturalBoxFromPoints(view, { x: 84, y: 84 }, { x: 98, y: 98 }, IMAGE)).toEqual({ x: 10, y: 10, w: 3, h: 3 });
  });

  test('a drag past the image\'s edges is clamped to the image; one wholly beside it is no box', () => {
    const view = { x: 100, y: 50, scale: 0.25 };
    const box = naturalBoxFromPoints(view, { x: 0, y: 0 }, { x: 300, y: 200 }, IMAGE)!;
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    const far = naturalBoxFromPoints(view, { x: 2000, y: 0 }, { x: 2100, y: 40 }, IMAGE);
    expect(far).toBeNull();
    expect(stageToNatural(view, 100, 50)).toEqual({ x: 0, y: 0 });
  });

  test('the part on screen (Enter in Region mode) is what the stage shows, inside the image', () => {
    expect(visibleNaturalBox({ x: -1500, y: -200, scale: 1 }, IMAGE, STAGE)).toEqual({ x: 1500, y: 200, w: 1200, h: 700 });
    // At Fit the whole image is on screen.
    expect(visibleNaturalBox({ x: 0, y: 108, scale: 1200 / 3664 }, IMAGE, STAGE)).toEqual({ x: 0, y: 0, w: 3664, h: 1453 });
  });
});

describe('zooming to a box', () => {
  const limits = zoomLimits(IMAGE, STAGE);

  test('a small box is shown large and centred', () => {
    const box = { x: 1820, y: 380, w: 420, h: 160 };
    const view = viewportForBox(box, IMAGE, STAGE, limits);
    const rect = naturalBoxToStage(view, box);
    expect(view.scale).toBeCloseTo(Math.min(600 / 420, 350 / 160), 6);
    expect(rect.left + rect.width / 2).toBeCloseTo(STAGE.width / 2, 6);
    expect(rect.top + rect.height / 2).toBeCloseTo(STAGE.height / 2, 6);
  });

  test('a tiny box stops at 800%, a box at a corner stays as central as the image allows', () => {
    const tiny = viewportForBox({ x: 5, y: 5, w: 2, h: 2 }, IMAGE, STAGE, limits);
    expect(tiny.scale).toBe(8);
    // The image is never panned out of the stage: the corner box sits at the corner.
    expect(tiny.x).toBe(0);
    expect(tiny.y).toBe(0);
    const rect = naturalBoxToStage(tiny, { x: 5, y: 5, w: 2, h: 2 });
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
  });

  test('a box as large as the image stays at Fit', () => {
    const view = viewportForBox({ x: 0, y: 0, w: 3664, h: 1453 }, IMAGE, STAGE, limits);
    expect(view.scale).toBeCloseTo(limits.min, 6);
  });
});
