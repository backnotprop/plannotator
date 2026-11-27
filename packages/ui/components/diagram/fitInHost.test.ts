/**
 * An inline diagram at rest (before the person zooms or pans) is never under its zoom strip: when the fitted drawing
 * would reach the strip, the box grows by at most the strip's band and the drawing, at the same scale, sits above it.
 * A drawing already clear of the strip is placed as before, in a box that does not grow.
 *
 * The sizes are the Plannotator page's on a 390 px phone (a 356 px canvas) and at desktop width (758 px), and the
 * strip's band is the one measured in Chromium and WebKit there: on a phone the strip sits 16 px in from the bottom
 * left and is 34 px tall and 94 px wide; at desktop width, 12 px in from the bottom right. (happy-dom lays nothing
 * out, so the browser layout itself is checked with real browsers, not here.)
 */
import { describe, expect, test } from 'bun:test';
import { fitInHost, type ContentSize, type ControlsBand } from './useDiagramViewport';

const PHONE_WIDTH = 356;
const DESKTOP_WIDTH = 758;
const STRIP_HEIGHT = 34;
const phoneStrip: ControlsBand = { left: 16, right: 110, height: 50 };
const desktopStrip: ControlsBand = { left: DESKTOP_WIDTH - 106, right: DESKTOP_WIDTH - 12, height: 46 };

/** The canvas height the page gives each drawing (`inlineHeight`: at most its own size, plus 48, clamped, less the border). */
const CASES: Array<{ name: string; content: ContentSize; phoneHeight: number; desktopHeight: number }> = [
  { name: 'the 4-node top-down flowchart', content: { width: 267, height: 328 }, phoneHeight: 374, desktopHeight: 374 },
  { name: 'a two-node flowchart', content: { width: 210, height: 64 }, phoneHeight: 254, desktopHeight: 254 },
  { name: 'a wide flowchart', content: { width: 1328, height: 164 }, phoneHeight: 254, desktopHeight: 254 },
  { name: 'a tall flowchart', content: { width: 100, height: 832 }, phoneHeight: 546.6, desktopHeight: 574 },
];

function intersects(a: { left: number; top: number; right: number; bottom: number }, b: typeof a): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function drawingRect(viewport: { x: number; y: number; scale: number }, content: ContentSize) {
  return { left: viewport.x, top: viewport.y, right: viewport.x + content.width * viewport.scale, bottom: viewport.y + content.height * viewport.scale };
}

/** The strip's rect in a box `box` px tall. */
function stripRect(strip: ControlsBand, box: number) {
  return { left: strip.left, right: strip.right, top: box - strip.height, bottom: box - strip.height + STRIP_HEIGHT };
}

function atRest(width: number, height: number, content: ContentSize, strip: ControlsBand) {
  const { viewport, reserve } = fitInHost({ width, height }, content, 1, strip);
  const plain = fitInHost({ width, height }, content, 1, null);
  return {
    viewport,
    reserve,
    drawing: drawingRect(viewport, content),
    strip: stripRect(strip, height + reserve),
    plain: plain.viewport,
    clearWithoutReserve: !intersects(drawingRect(plain.viewport, content), stripRect(strip, height)),
  };
}

describe('fitInHost keeps an inline drawing clear of the zoom strip at rest', () => {
  for (const c of CASES) {
    test(`${c.name}, on a 390 px phone and at desktop width`, () => {
      for (const [width, height, strip] of [
        [PHONE_WIDTH, c.phoneHeight, phoneStrip],
        [DESKTOP_WIDTH, c.desktopHeight, desktopStrip],
      ] as const) {
        const r = atRest(width, height, c.content, strip);
        expect(intersects(r.drawing, r.strip)).toBe(false);
        // Never drawn smaller than Fit draws it, the drawing inside the box, and the box grows by at most the band.
        expect(r.viewport.scale).toBe(r.plain.scale);
        expect(r.drawing.top).toBeGreaterThanOrEqual(0);
        expect(r.drawing.bottom).toBeLessThanOrEqual(height + r.reserve);
        expect(r.reserve).toBeLessThanOrEqual(strip.height);
        // A drawing that was already clear keeps its place and its box.
        if (r.clearWithoutReserve) expect([r.reserve, r.viewport]).toEqual([0, r.plain]);
      }
    });
  }

  test('the 4-node flowchart on a phone gets room under it; the drawing sits centred above the strip', () => {
    const r = atRest(PHONE_WIDTH, 374, CASES[0].content, phoneStrip);
    expect(r.clearWithoutReserve).toBe(false);
    // The box grows by the strip and its margin, no more.
    expect(r.reserve).toBe(phoneStrip.height);
    const above = 374 + r.reserve - phoneStrip.height;
    expect(r.drawing.top).toBeCloseTo(above - r.drawing.bottom, 6);
  });
});
