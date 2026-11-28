import { describe, expect, test } from 'bun:test';
import { panBy, zoomAt } from '../imageZoom';
import {
  ANNOTATOR_BASE_PAD,
  ANNOTATOR_CANVAS_MAX_SIDE,
  annotatorBase,
  annotatorCanvasRatio,
  annotatorInitialView,
  annotatorLimits,
  annotatorOnPicture,
  annotatorPoint,
} from './zoom';

// A phone's drawing area: 393 wide, less the tools above and the hint below.
const AREA = { width: 377, height: 640 };

/** Where a base point is drawn on the area at a view (the transform the canvas is given). */
const onScreen = (view: { x: number; y: number; scale: number }, p: { x: number; y: number }) => ({ x: view.x + p.x * view.scale, y: view.y + p.y * view.scale });
/** A base point in the picture's own pixels (what the export draws: natural / base). */
const inPicture = (natural: { width: number }, base: { width: number }, p: { x: number; y: number }) => ({ x: (p.x * natural.width) / base.width, y: (p.y * natural.width) / base.width });

describe('the drawing screen on a phone: where a stroke lands', () => {
  test('a finger at zoom Z and pan P marks the picture pixel under it', () => {
    const natural = { width: 2400, height: 576 };
    const base = annotatorBase(natural, AREA);
    const limits = annotatorLimits(natural, base);
    // Zoom 3× about a point, then pan left: a transform the person made with two fingers.
    let view = annotatorInitialView(natural, base, AREA, null);
    view = zoomAt(view, 3 / view.scale, 100, 320, base, AREA, limits);
    view = panBy(view, -140, 0, base, AREA, limits);
    expect(view.scale).toBeCloseTo(3, 5);
    // The finger on the area's point (200, 320): the base point under it, drawn back exactly there.
    const finger = { x: 200, y: 320 };
    const p = annotatorPoint(view, finger.x, finger.y);
    const back = onScreen(view, p);
    expect(back.x).toBeCloseTo(finger.x, 6);
    expect(back.y).toBeCloseTo(finger.y, 6);
    // And the picture pixel: the base point times natural / base, the column the finger is over.
    const px = inPicture(natural, base, p);
    const columnUnderFinger = ((finger.x - view.x) / (base.width * view.scale)) * natural.width;
    expect(px.x).toBeCloseTo(columnUnderFinger, 6);
    expect(px.x).toBeGreaterThan(0);
    expect(px.x).toBeLessThan(natural.width);
  });

  test('the same finger at two zooms marks two places; at zoom 1 it is the plain offset', () => {
    const natural = { width: 1200, height: 900 };
    const base = annotatorBase(natural, AREA);
    const whole = annotatorInitialView(natural, base, AREA, null);
    expect(whole.scale).toBe(1);
    const at1 = annotatorPoint(whole, 150, 300);
    expect(at1).toEqual({ x: 150 - whole.x, y: 300 - whole.y });
    // 3×: the picture now covers the area both ways, so nothing re-centres it.
    const zoomed = zoomAt(whole, 3, 150, 300, base, AREA, annotatorLimits(natural, base));
    // Zoomed about the finger itself: the point under it does not move.
    const at2 = annotatorPoint(zoomed, 150, 300);
    expect(at2.x).toBeCloseTo(at1.x, 6);
    expect(at2.y).toBeCloseTo(at1.y, 6);
    // A finger 60 px to the right is 20 base px away at 3×, 60 at 1×.
    expect(annotatorPoint(zoomed, 210, 300).x - at2.x).toBeCloseTo(20, 6);
    expect(annotatorPoint(whole, 210, 300).x - at1.x).toBeCloseTo(60, 6);
  });

  test('a press beside the picture is not on it', () => {
    const natural = { width: 2400, height: 576 };
    const base = annotatorBase(natural, AREA);
    const view = { x: 8, y: 300, scale: 1 };
    expect(annotatorOnPicture(view, base, 20, 310)).toBe(true);
    expect(annotatorOnPicture(view, base, 20, 100)).toBe(false);
  });
});

describe('the drawing screen on a phone: how a picture opens', () => {
  test('the base fits the whole picture inside the area, never above its own pixels', () => {
    const wide = annotatorBase({ width: 2400, height: 576 }, AREA);
    expect(wide.width).toBe(AREA.width - 2 * ANNOTATOR_BASE_PAD);
    const tall = annotatorBase({ width: 900, height: 3367 }, AREA);
    expect(tall.height).toBeLessThanOrEqual(AREA.height - 2 * ANNOTATOR_BASE_PAD);
    expect(tall.height).toBeGreaterThan(AREA.height - 2 * ANNOTATOR_BASE_PAD - 5);
    // The export scales both axes by naturalWidth / clientWidth (an integer): that has to be the picture's own
    // scale on Y too, or a stroke at the foot of a tall picture lands pixels off (a 900 × 3367 screenshot).
    for (const [natural, base] of [
      [{ width: 2400, height: 576 }, wide],
      [{ width: 900, height: 3367 }, tall],
    ] as const) {
      expect(Number.isInteger(base.width)).toBe(true);
      const exportScale = natural.width / base.width;
      expect(base.height * exportScale).toBeCloseTo(natural.height, 9);
    }
    expect(annotatorBase({ width: 120, height: 80 }, AREA)).toEqual({ width: 120, height: 80 });
  });

  test('a panorama opens a third of the area tall from its left, not as a sliver; it pinches out to the whole', () => {
    const natural = { width: 2400, height: 576 };
    const base = annotatorBase(natural, AREA);
    const view = annotatorInitialView(natural, base, AREA, null);
    expect(base.height * view.scale).toBeCloseTo(AREA.height / 3, 4);
    expect(view.x).toBe(0);
    // Centred on the height.
    expect(view.y + (base.height * view.scale) / 2).toBeCloseTo(AREA.height / 2, 4);
    // The viewer showed it whole (a phone fits a panorama whole): the same.
    expect(annotatorInitialView(natural, base, AREA, { x: 0, y: 0, w: 2400, h: 576 })).toEqual(view);
    expect(annotatorLimits(natural, base).min).toBe(1);
  });

  test('a tall screenshot opens filling the width from its top', () => {
    const natural = { width: 900, height: 3367 };
    const base = annotatorBase(natural, AREA);
    const view = annotatorInitialView(natural, base, AREA, null);
    expect(base.width * view.scale).toBeCloseTo(AREA.width, 4);
    expect(view.x).toBeCloseTo(0, 6);
    expect(view.y).toBe(0);
  });

  test('an ordinary picture opens whole and centred', () => {
    const natural = { width: 1200, height: 900 };
    const base = annotatorBase(natural, AREA);
    const view = annotatorInitialView(natural, base, AREA, null);
    expect(view.scale).toBe(1);
    expect(view.x).toBeCloseTo((AREA.width - base.width) / 2, 6);
    expect(view.y).toBeCloseTo((AREA.height - base.height) / 2, 6);
  });

  test('the part the viewer showed, zoomed in, is what the drawing screen opens on', () => {
    const natural = { width: 900, height: 3367 };
    const base = annotatorBase(natural, AREA);
    // The viewer showed the picture's width, 1200 to 2100 px down.
    const shown = { x: 0, y: 1200, w: 900, h: 900 };
    const view = annotatorInitialView(natural, base, AREA, shown);
    const k = base.width / natural.width;
    // Its top-left at the area's top-left, its width filling the area.
    expect(view.scale * shown.w * k).toBeCloseTo(AREA.width, 4);
    const topLeft = onScreen(view, { x: shown.x * k, y: shown.y * k });
    expect(topLeft.x).toBeCloseTo(0, 4);
    expect(topLeft.y).toBeCloseTo(0, 4);
  });

  test('zoom goes far enough that a picture pixel is a few screen pixels, and never under 4×', () => {
    const natural = { width: 2400, height: 576 };
    const base = annotatorBase(natural, AREA);
    expect(annotatorLimits(natural, base).max).toBeCloseTo((3 * 2400) / base.width, 6);
    const small = { width: 120, height: 80 };
    expect(annotatorLimits(small, annotatorBase(small, AREA)).max).toBe(4);
  });

  test('a zoomed canvas is redrawn sharp, within a cap', () => {
    const base = { width: 361, height: 87 };
    expect(annotatorCanvasRatio(base, 1, 3)).toBe(3);
    expect(annotatorCanvasRatio(base, 2, 3)).toBe(6);
    expect(annotatorCanvasRatio(base, 20, 3) * base.width).toBeCloseTo(ANNOTATOR_CANVAS_MAX_SIDE, 6);
  });

  test('after the area shrinks (a phone turned), the whole picture can still be pinched back into view', () => {
    const natural = { width: 2400, height: 576 };
    const base = annotatorBase(natural, { width: 820, height: 300 });
    const turned = { width: 377, height: 640 };
    const limits = annotatorLimits(natural, base, turned);
    expect(limits.min).toBeCloseTo(turned.width / base.width, 6);
    expect(base.width * limits.min).toBeLessThanOrEqual(turned.width + 1e-9);
    // Unchanged area: the whole picture is scale 1, as before.
    expect(annotatorLimits(natural, base, { width: 820, height: 300 }).min).toBe(1);
  });
});
