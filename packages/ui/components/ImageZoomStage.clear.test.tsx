/**
 * The stage's `clear` rows: a host floats things over the top and bottom of the
 * stage, and Fit and the pan's limits work between them while the stage itself
 * stays whole. The failures this guards: a picture fitted under what floats, a
 * pan that cannot bring its bottom clear, a pinch or a pan that drifts because
 * its coordinates are off by the top row, a picture jumping when the rows change
 * while it is zoomed, and a host that passes nothing (the lightbox) seeing any
 * of it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * happy-dom has no layout, so the stage's box and the image's size are given here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ZoomClear } from './imageZoom';

const hasDom = typeof document !== 'undefined';
const { ImageZoomStage } = (hasDom ? await import('./ImageZoomStage') : {}) as typeof import('./ImageZoomStage');
type ZoomMode = import('./ImageZoomStage').ZoomMode;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.replaceChildren();
});

/** A 1000 × 600 stage whose top row is 100 px and whose bottom row is 200 px, so 300 px stay clear. */
const CLEAR: ZoomClear = { top: 100, bottom: 200 };
const CLEAR_BOTTOM = 600 - 200;

function Stage({ start, clear, onMode, fitAxis }: { start: ZoomMode; clear?: ZoomClear; onMode?: (mode: ZoomMode) => void; fitAxis?: 'width' }) {
  const [mode, setMode] = React.useState<ZoomMode>(start);
  return (
    <ImageZoomStage
      src="/picture.png"
      alt="A picture"
      label="Image: a picture"
      mode={mode}
      onModeChange={(next) => {
        setMode(next);
        onMode?.(next);
      }}
      padding={0}
      clear={clear}
      fitAxis={fitAxis}
    />
  );
}

async function mount(start: ZoomMode, clear: ZoomClear | undefined, width = 2000, height = 1000, fitAxis?: 'width') {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Stage start={start} clear={clear} fitAxis={fitAxis} />);
  });
  const img = host.querySelector<HTMLImageElement>('[data-lightbox-image]')!;
  const stage = img.parentElement as HTMLElement;
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height });
  await act(async () => {
    img.dispatchEvent(new Event('load'));
  });
  return { stage, img };
}

async function setClear(start: ZoomMode, clear: ZoomClear | undefined, fitAxis?: 'width') {
  await act(async () => {
    root!.render(<Stage start={start} clear={clear} fitAxis={fitAxis} />);
  });
}

function view(el: HTMLElement) {
  const m = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(el.style.transform);
  if (!m) throw new Error(`no transform: ${el.style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

async function pointer(stage: HTMLElement, type: string, id: number, x: number, y: number, pointerType = 'touch') {
  await act(async () => {
    stage.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, button: 0, pointerType, bubbles: true, cancelable: true }));
  });
}

async function panBy(stage: HTMLElement, dx: number, dy: number) {
  await pointer(stage, 'pointerdown', 1, 500, 300);
  await pointer(stage, 'pointermove', 1, 500 + dx, 300 + dy);
  await pointer(stage, 'pointerup', 1, 500 + dx, 300 + dy);
}

async function ctrlWheel(stage: HTMLElement, deltaY: number, x: number, y: number) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  Object.defineProperty(event, 'ctrlKey', { value: true });
  await act(async () => {
    stage.dispatchEvent(event);
  });
}

describe.if(hasDom)('the stage keeps clear of the rows a host floats things over', () => {
  test('Fit fits the picture between the rows', async () => {
    const { img } = await mount('fit', CLEAR);
    // 300 px of height for a 2:1 picture: 600 × 300 at 30%, centred across, from the top row down.
    expect(view(img)).toEqual({ x: 200, y: 100, scale: 0.3 });
  });

  test('a pan stops with the picture\'s edges exactly at the rows, top and bottom', async () => {
    const { stage, img } = await mount('actual', CLEAR);
    await panBy(stage, 0, -5000);
    expect(view(img).y + 1000).toBe(CLEAR_BOTTOM);
    await panBy(stage, 0, 5000);
    expect(view(img).y).toBe(CLEAR.top);
  });

  test('a pan reaches both sides at their stop, which the rows leave alone', async () => {
    const { stage, img } = await mount('actual', CLEAR);
    await panBy(stage, -5000, 0);
    expect(view(img).x).toBe(1000 - 2000);
    await panBy(stage, 5000, 0);
    expect(view(img).x).toBe(0);
  });

  test('a picture larger than the clear space still slides under the rows while it pans', async () => {
    const { stage, img } = await mount('actual', CLEAR);
    await panBy(stage, 0, -5000);
    await panBy(stage, 0, 200);
    const { y } = view(img);
    expect(y).toBeLessThan(CLEAR.top);
    expect(y + 1000).toBeGreaterThan(CLEAR_BOTTOM);
  });

  test('a zoom about the pointer keeps the pixel under it, in a row or between them', async () => {
    const { stage, img } = await mount('actual', CLEAR);
    await panBy(stage, 0, -100);
    for (const y of [50, 250, 550]) {
      const before = view(img);
      const pixel = (y - before.y) / before.scale;
      await ctrlWheel(stage, -40, 700, y);
      const after = view(img);
      expect(after.scale).toBeGreaterThan(before.scale);
      expect(after.y + pixel * after.scale).toBeCloseTo(y, 5);
    }
  });

  test('zooming out goes as far as it did, down to the whole picture between the rows', async () => {
    const { stage, img } = await mount('fit', CLEAR, 1000, 3000);
    for (let i = 0; i < 8; i++) await ctrlWheel(stage, 200, 500, 300);
    const { y, scale } = view(img);
    expect(scale).toBeCloseTo(0.1, 5);
    expect(y).toBeGreaterThanOrEqual(CLEAR.top - 0.001);
    expect(y + 3000 * scale).toBeLessThanOrEqual(CLEAR_BOTTOM + 0.001);
  });

  test('when the rows go, Fit takes the whole stage', async () => {
    const { img } = await mount('fit', CLEAR);
    await setClear('fit', undefined);
    expect(view(img)).toEqual({ x: 0, y: 50, scale: 0.5 });
  });

  test('a zoomed picture stays where it is on screen when the rows go, and within the limits when they come', async () => {
    const { stage, img } = await mount('actual', CLEAR);
    await panBy(stage, 0, -150);
    const onScreen = view(img);
    await setClear('actual', undefined);
    expect(view(img)).toEqual(onScreen);
    await setClear('actual', CLEAR);
    expect(view(img)).toEqual(onScreen);
    // At the top stop, with nothing above the picture: once the row goes there is nothing to hold it down.
    await panBy(stage, 0, 5000);
    expect(view(img).y).toBe(CLEAR.top);
    await setClear('actual', undefined);
    expect(view(img).y).toBe(0);
  });

  test('a tall picture panned at Fit stays where it is on screen when the rows come or go; resting at Fit it refits', async () => {
    // 1000 × 3000 fitted to the stage's width: it reads from the top, 3000 px tall under a 300 px clear space.
    const { stage, img } = await mount('fit', CLEAR, 1000, 3000, 'width');
    const resting = view(img);
    expect(resting.scale).toBe(1);
    await panBy(stage, 0, -400);
    const panned = view(img);
    expect(panned.y).toBeLessThan(resting.y);
    // Hide, minimize, a second typed line: the rows go, and the place the person panned to holds.
    await setClear('fit', undefined, 'width');
    expect(view(img).y).toBe(panned.y);
    await setClear('fit', CLEAR, 'width');
    expect(view(img).y).toBe(panned.y);
    // Resting at Fit it still eases to the new space.
    await act(async () => root!.unmount());
    root = null;
    const again = await mount('fit', CLEAR, 1000, 3000, 'width');
    await setClear('fit', undefined, 'width');
    expect(view(again.img).y).toBe(0);
  });

  test('a host that passes no rows keeps the whole stage', async () => {
    const { img: fitted } = await mount('fit', undefined);
    expect(view(fitted)).toEqual({ x: 0, y: 50, scale: 0.5 });
    await act(async () => root!.unmount());
    root = null;
    const { stage, img } = await mount('actual', undefined);
    await panBy(stage, 0, -5000);
    expect(view(img).y + 1000).toBe(600);
    await panBy(stage, 0, 5000);
    expect(view(img).y).toBe(0);
  });
});
