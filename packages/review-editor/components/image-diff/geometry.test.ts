import { describe, expect, test } from 'bun:test';
import { fitScale, floorToDevice, stageLayout, stepSwipe, swipeClipX } from './geometry';

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

  test('small images scale up by whole steps, so pixels stay square', () => {
    expect(fitScale({ width: 16, height: 16 }, { width: 600, height: 480 })).toBe(8);
    expect(fitScale({ width: 100, height: 100 }, { width: 350, height: 480 })).toBe(3);
    expect(fitScale({ width: 2000, height: 1000 }, { width: 1000, height: 480 })).toBeCloseTo(0.48);
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
