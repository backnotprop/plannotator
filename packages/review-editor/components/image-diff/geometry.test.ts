import { describe, expect, test } from 'bun:test';
import { deviceNudge } from './ImageStage';
import { fitScale, floorToDevice, sideBySideColumns, sideBySidePaneWidth, stageLayout, stepSwipe, swipeClipX } from './geometry';

const widths = [390, 768, 1280, 1917];
const dprs = [1, 1.25, 1.5, 2, 3];

function onDeviceGrid(value: number, dpr: number): boolean {
  return Math.abs(value * dpr - Math.round(value * dpr)) < 1e-9;
}

describe('stageLayout keeps both images registered', () => {
  for (const dpr of dprs) {
    for (const width of widths) {
      for (const zoom of ['fit', 'actual'] as const) {
        test(`same size images share one box at ${width}px, dpr ${dpr}, ${zoom}`, () => {
          const size = { width: 2560, height: 1440 };
          const layout = stageLayout({ old: size, new: size, available: { width, height: 480 }, zoom, dpr });
          expect(layout.old).toEqual(layout.new);
          expect(layout.old).toEqual(layout.stage);
          expect(onDeviceGrid(layout.stage.width, dpr) && onDeviceGrid(layout.stage.height, dpr) && onDeviceGrid(layout.offsetX, dpr)).toBe(true);
          if (zoom === 'actual') expect(layout.stage).toEqual(size);
        });

        test(`different sizes keep one scale, aligned top left, never stretched, at ${width}px, dpr ${dpr}, ${zoom}`, () => {
          const old = { width: 1200, height: 800 };
          const next = { width: 1000, height: 900 };
          const layout = stageLayout({ old, new: next, available: { width, height: 480 }, zoom, dpr });
          expect(layout.stage.width).toBe(floorToDevice(1200 * layout.scale, dpr));
          expect(layout.stage.height).toBe(floorToDevice(900 * layout.scale, dpr));
          expect(Math.abs(layout.old!.width / old.width - layout.new!.width / next.width)).toBeLessThan(1 / dpr / 900 + 1e-9);
          expect(Math.abs(layout.old!.width / layout.old!.height - old.width / old.height)).toBeLessThan(0.01);
          expect(Math.abs(layout.new!.width / layout.new!.height - next.width / next.height)).toBeLessThan(0.01);
          expect(layout.stage.width).toBeLessThanOrEqual(zoom === 'fit' ? width : Infinity);
        });
      }
    }
  }

  test('fit never draws a raster image above its natural size', () => {
    expect(fitScale({ width: 96, height: 96 }, { width: 600, height: 480 })).toBe(1);
    expect(fitScale({ width: 2000, height: 1000 }, { width: 1000, height: 480 })).toBeCloseTo(0.48);
    const icon = stageLayout({ old: { width: 96, height: 96 }, new: { width: 96, height: 96 }, available: { width: 900, height: 640 }, zoom: 'fit', dpr: 2 });
    expect(icon.stage).toEqual({ width: 96, height: 96 });
    expect(icon.pixelated).toBe(false);
  });

  test('an SVG may scale up, at most twice and at most 320 px tall', () => {
    expect(fitScale({ width: 64, height: 64 }, { width: 900, height: 640 }, true)).toBe(2);
    expect(fitScale({ width: 200, height: 200 }, { width: 900, height: 640 }, true)).toBe(1.6);
    expect(fitScale({ width: 64, height: 64 }, { width: 100, height: 640 }, true)).toBeCloseTo(100 / 64);
    expect(fitScale({ width: 600, height: 600 }, { width: 300, height: 640 }, true)).toBe(0.5);
    const logo = stageLayout({ old: { width: 64, height: 64 }, new: { width: 64, height: 64 }, available: { width: 900, height: 640 }, zoom: 'fit', dpr: 1, vector: true });
    expect(logo.stage).toEqual({ width: 128, height: 128 });
    expect(logo.pixelated).toBe(false);
  });

  test('one scale for every view: the side-by-side pane width decides it', () => {
    const before = { width: 200, height: 100 };
    const after = { width: 260, height: 140 };
    for (const width of [390, 768, 1280]) {
      const columns = sideBySideColumns({ width: 260, height: 140 }, width);
      const pane = sideBySidePaneWidth(width, columns);
      const layout = stageLayout({ old: before, new: after, available: { width: pane, height: 480 }, zoom: 'fit', dpr: 2 });
      expect(layout.scale).toBe(1);
      expect(layout.new).toEqual(after);
    }
    const big = stageLayout({ old: { width: 2400, height: 400 }, new: { width: 2400, height: 264 }, available: { width: sideBySidePaneWidth(1000, true), height: 480 }, zoom: 'fit', dpr: 1 });
    expect(big.stage.width).toBeLessThanOrEqual(492);
  });

  test('before and after stack only when the two do not fit side by side at 100%', () => {
    expect(sideBySideColumns({ width: 200, height: 100 }, 430)).toBe(true);
    expect(sideBySideColumns({ width: 200, height: 100 }, 358)).toBe(false);
    expect(sideBySideColumns({ width: 260, height: 140 }, 358)).toBe(false);
    expect(sideBySideColumns({ width: 2400, height: 400 }, 358)).toBe(false);
    expect(sideBySideColumns({ width: 2400, height: 400 }, 900)).toBe(true);
  });

  test('Actual size is 100% for every kind', () => {
    for (const vector of [false, true]) {
      const layout = stageLayout({ old: { width: 64, height: 64 }, new: { width: 64, height: 64 }, available: { width: 900, height: 640 }, zoom: 'actual', dpr: 2, vector });
      expect(layout.stage).toEqual({ width: 64, height: 64 });
    }
  });
});

describe('swipe', () => {
  test('the divider lands on a device pixel', () => {
    expect(swipeClipX(0.5, 301, 2)).toBe(150.5);
    expect(swipeClipX(0.333, 300, 1)).toBe(100);
    expect(swipeClipX(2, 300, 1)).toBe(300);
  });

  test('keys move it in small and large steps and stop at the edges', () => {
    expect(stepSwipe(0.5, 'ArrowRight', false)).toBeCloseTo(0.51);
    expect(stepSwipe(0.5, 'ArrowLeft', true)).toBeCloseTo(0.4);
    expect(stepSwipe(0.995, 'ArrowRight', false)).toBe(1);
    expect(stepSwipe(0.3, 'Home', false)).toBe(0);
    expect(stepSwipe(0.3, 'a', false)).toBeNull();
  });
});

describe('the stage starts on a whole device pixel', () => {
  test('a fractional offset is nudged forward to the next device pixel', () => {
    expect(deviceNudge(100.5, 1)).toBeCloseTo(0.5);
    expect(deviceNudge(100.25, 2)).toBeCloseTo(0.25);
    expect(deviceNudge(100.5, 2)).toBe(0);
    expect(deviceNudge(100, 1)).toBe(0);
  });
});
