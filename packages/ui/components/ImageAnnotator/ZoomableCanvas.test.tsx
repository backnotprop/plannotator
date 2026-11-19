/**
 * The drawing screen's zoomable area on a phone (`ImageAnnotator`'s
 * `zoomable`): one finger draws where it is at any zoom, a stroke is as wide
 * on screen as the size chosen, a second finger pinches (dropping a stroke it
 * just started) and the finger left after a pinch draws nothing.
 *
 * DOM-gated (happy-dom has no layout: the area's box and the picture's size
 * are given here). The geometry itself is in zoom.test.ts; the real browser
 * proof is tests/e2e/inbox-phone-annotate.spec.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImageAnnotator } from './index';
import { ZoomableCanvas, PINCH_DROPS_STROKE_MS } from './ZoomableCanvas';
import type { Point } from './types';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const realRect = hasDom ? HTMLElement.prototype.getBoundingClientRect : null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (realRect) HTMLElement.prototype.getBoundingClientRect = realRect;
});

const AREA = { left: 8, top: 60, width: 377, height: 640 };
/** The area's box now (a test turns the phone by changing it). */
let box = { ...AREA };

function giveAreaABox() {
  box = { ...AREA };
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute('data-pn-image-annotator-area')) {
      return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON() {} } as DOMRect;
    }
    return realRect!.call(this);
  };
}

async function loadPicture(width: number, height: number) {
  const img = host!.querySelector<HTMLImageElement>('[data-pn-image-annotator-content] img')!;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height });
  await act(async () => {
    img.dispatchEvent(new Event('load'));
  });
}

function transform() {
  const el = host!.querySelector<HTMLElement>('[data-pn-image-annotator-content]')!;
  const m = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(el.style.transform);
  if (!m) throw new Error(`no transform: ${el.style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

function mountCanvas(calls: string[], starts: { point: Point; zoom: number }[] = []) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return act(async () => {
    root!.render(
      <ZoomableCanvas
        imageSrc="data:image/png;base64,"
        strokes={[]}
        currentStroke={null}
        onStrokeStart={(point, zoom) => {
          calls.push('start');
          starts.push({ point, zoom });
        }}
        onStrokeMove={() => calls.push('move')}
        onStrokeEnd={() => calls.push('end')}
        onStrokeCancel={() => calls.push('cancel')}
        onImageLoad={() => {}}
      />,
    );
  });
}

async function pointer(type: string, id: number, x: number, y: number, timeStamp?: number) {
  const area = host!.querySelector<HTMLElement>('[data-pn-image-annotator-area]')!;
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0, isPrimary: id === 1 });
  if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  await act(async () => {
    area.dispatchEvent(event);
  });
}

describe.if(hasDom)('the zoomable drawing area', () => {
  test('one finger draws where it is at the zoom shown; two fingers zoom and drop a stroke they just started; the finger left draws nothing', async () => {
    giveAreaABox();
    const calls: string[] = [];
    const starts: { point: Point; zoom: number }[] = [];
    const moves: Point[] = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ZoomableCanvas
          imageSrc="data:image/png;base64,"
          strokes={[]}
          currentStroke={null}
          onStrokeStart={(point, zoom) => {
            calls.push('start');
            starts.push({ point, zoom });
          }}
          onStrokeMove={(point) => {
            calls.push('move');
            moves.push(point);
          }}
          onStrokeEnd={() => calls.push('end')}
          onStrokeCancel={() => calls.push('cancel')}
          onImageLoad={() => {}}
        />,
      );
    });
    await loadPicture(2400, 576);
    // A panorama opens a third of the area tall, from its left (zoom.ts).
    const opened = transform();
    expect(opened.x).toBe(0);
    expect(opened.scale).toBeGreaterThan(2);

    // One finger: the stroke's point is the base pixel under it at this zoom, and the zoom is passed on.
    await pointer('pointerdown', 1, AREA.left + 100, AREA.top + 320, 1000);
    expect(starts[0]!.zoom).toBeCloseTo(opened.scale, 6);
    expect(starts[0]!.point.x).toBeCloseTo(100 / opened.scale, 6);
    expect(starts[0]!.point.y).toBeCloseTo((320 - opened.y) / opened.scale, 6);
    await pointer('pointermove', 1, AREA.left + 160, AREA.top + 330, 1400);
    expect(moves[0]!.x).toBeCloseTo(160 / opened.scale, 6);
    await pointer('pointerup', 1, AREA.left + 160, AREA.top + 330, 1500);
    expect(calls).toEqual(['start', 'move', 'end']);

    // A second finger in a young stroke: the stroke was the pinch's first finger, so it is dropped.
    calls.length = 0;
    await pointer('pointerdown', 1, AREA.left + 150, AREA.top + 300, 2000);
    await pointer('pointerdown', 2, AREA.left + 250, AREA.top + 300, 2000 + PINCH_DROPS_STROKE_MS - 50);
    expect(calls).toEqual(['start', 'cancel']);
    // Spread apart: zoomed about their middle.
    await pointer('pointermove', 1, AREA.left + 100, AREA.top + 300);
    await pointer('pointermove', 2, AREA.left + 300, AREA.top + 300);
    const zoomed = transform();
    expect(zoomed.scale).toBeCloseTo(opened.scale * 2, 4);
    // The point under the fingers' middle stayed put.
    const before = (200 - opened.x) / opened.scale;
    const after = (200 - zoomed.x) / zoomed.scale;
    expect(after).toBeCloseTo(before, 4);
    // One finger lifts: the one left drags nothing and draws nothing.
    await pointer('pointerup', 2, AREA.left + 300, AREA.top + 300);
    await pointer('pointermove', 1, AREA.left + 40, AREA.top + 380);
    await pointer('pointerup', 1, AREA.left + 40, AREA.top + 380);
    expect(calls).toEqual(['start', 'cancel']);

    // A stroke drawn for a while is kept when a second finger lands.
    calls.length = 0;
    await pointer('pointerdown', 1, AREA.left + 150, AREA.top + 300, 5000);
    await pointer('pointermove', 1, AREA.left + 190, AREA.top + 310, 5300);
    await pointer('pointerdown', 2, AREA.left + 250, AREA.top + 300, 5000 + PINCH_DROPS_STROKE_MS + 200);
    expect(calls).toEqual(['start', 'move', 'end']);
  });

  test('ImageAnnotator with zoomable draws on the zoomable area, and a stroke there is kept (Undo can take it)', async () => {
    giveAreaABox();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ImageAnnotator imageSrc="data:image/png;base64," isOpen zoomable escapeCancels onAccept={async () => {}} onClose={() => {}} />);
    });
    expect(host.querySelector('[data-pn-image-annotator-stage]')!.hasAttribute('data-pn-image-annotator-zoomable')).toBe(true);
    // The plain preview's canvas is not there: the zoomable area is.
    expect(host.querySelector('[data-pn-image-annotator-area]')).not.toBeNull();
    await loadPicture(2400, 576);
    const undo = host.querySelector<HTMLButtonElement>('button[title="Undo (Cmd+Z)"]')!;
    expect(undo.disabled).toBe(true);
    await pointer('pointerdown', 1, AREA.left + 100, AREA.top + 320, 1000);
    await pointer('pointermove', 1, AREA.left + 180, AREA.top + 320, 1300);
    await pointer('pointerup', 1, AREA.left + 180, AREA.top + 320, 1400);
    expect(host.querySelector<HTMLButtonElement>('button[title="Undo (Cmd+Z)"]')!.disabled).toBe(false);
  });

  test('without zoomable the drawing screen is the plain preview, as before', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<ImageAnnotator imageSrc="data:image/png;base64," isOpen onAccept={async () => {}} onClose={() => {}} />);
    });
    expect(host.querySelector('[data-pn-image-annotator-area]')).toBeNull();
    expect(host.querySelector('[data-pn-image-annotator-stage]')!.hasAttribute('data-pn-image-annotator-zoomable')).toBe(false);
    expect(host.querySelector('[data-pn-image-annotator-stage]')!.classList.contains('max-w-full')).toBe(true);
  });

  test('a turned phone (the area resized) keeps every stroke where it was drawn: the base stays, only the view is kept in bounds', async () => {
    giveAreaABox();
    const calls: string[] = [];
    const starts: { point: Point; zoom: number }[] = [];
    await mountCanvas(calls, starts);
    await loadPicture(2400, 576);
    const img = host!.querySelector<HTMLImageElement>('[data-pn-image-annotator-content] img')!;
    const laidOut = img.style.width;
    expect(laidOut).toBe(`${AREA.width - 16}px`);
    // Turned: wide and short.
    box = { left: 20, top: 40, width: 800, height: 300 };
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    // The base (what the export scales strokes by, natural / clientWidth) did not follow the area.
    expect(img.style.width).toBe(laidOut);
    // A finger over a base point at the new view lands on that point.
    const view = transform();
    const target = { x: 120, y: 40 };
    await pointer('pointerdown', 1, box.left + view.x + target.x * view.scale, box.top + view.y + target.y * view.scale, 1000);
    expect(starts[0]!.point.x).toBeCloseTo(target.x, 6);
    expect(starts[0]!.point.y).toBeCloseTo(target.y, 6);
    await pointer('pointerup', 1, 0, 0, 1100);
  });

  test('three fingers: lifting one of the first two keeps the zoom where it was, no jump', async () => {
    giveAreaABox();
    const calls: string[] = [];
    await mountCanvas(calls);
    await loadPicture(2400, 576);
    await pointer('pointerdown', 1, AREA.left + 100, AREA.top + 320, 1000);
    await pointer('pointerdown', 2, AREA.left + 200, AREA.top + 320, 1010);
    await pointer('pointerdown', 3, AREA.left + 300, AREA.top + 400, 1020);
    const before = transform();
    // Finger 1 (of the pinch's pair) lifts; 2 and 3 stay where they are, then move a pixel.
    await pointer('pointerup', 1, AREA.left + 100, AREA.top + 320);
    await pointer('pointermove', 2, AREA.left + 201, AREA.top + 320);
    const after = transform();
    expect(after.scale / before.scale).toBeGreaterThan(0.99);
    expect(after.scale / before.scale).toBeLessThan(1.01);
    expect(Math.abs(after.x - before.x)).toBeLessThan(3);
  });

  test('a tap or a slip beside the picture records no stroke (Undo never takes an invisible one)', async () => {
    giveAreaABox();
    const calls: string[] = [];
    await mountCanvas(calls);
    await loadPicture(2400, 576);
    // The panorama opens centred a third of the area tall: the area's top 40 px are empty.
    expect(transform().y).toBeGreaterThan(40);
    await pointer('pointerdown', 1, AREA.left + 100, AREA.top + 10, 1000);
    await pointer('pointermove', 1, AREA.left + 115, AREA.top + 12, 1100);
    await pointer('pointerup', 1, AREA.left + 115, AREA.top + 12, 1200);
    expect(calls).toEqual(['start', 'move', 'cancel']);
    // A stroke that starts beside it and crosses onto it is a stroke.
    calls.length = 0;
    const view = transform();
    await pointer('pointerdown', 1, AREA.left + 100, AREA.top + 10, 2000);
    await pointer('pointermove', 1, AREA.left + 100, AREA.top + view.y + 20, 2100);
    await pointer('pointerup', 1, AREA.left + 100, AREA.top + view.y + 20, 2200);
    expect(calls).toEqual(['start', 'move', 'end']);
  });
});
