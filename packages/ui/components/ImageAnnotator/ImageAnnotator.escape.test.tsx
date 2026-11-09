/**
 * What Escape and a click outside do in the drawing screen (DOM_TESTS=1).
 * Default (plan review, and any host that passes nothing): Escape, Enter and a
 * click outside all accept the drawing, under "Press Esc or Enter or click
 * outside to accept". With `escapeCancels` (the Inbox): Escape closes and
 * accepts nothing, Enter accepts, and a click outside closes only an empty
 * drawing, so strokes are never lost to a stray click.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImageAnnotator } from './index';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const restores: (() => void)[] = [];

function stub<T extends object>(target: T, key: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restores.push(() => (previous ? Object.defineProperty(target, key, previous) : delete (target as Record<string, unknown>)[key]));
}

beforeEach(() => {
  if (!hasDom) return;
  const ctx = new Proxy({}, { get: () => () => {} });
  stub(HTMLCanvasElement.prototype, 'getContext', { value: () => ctx, writable: true });
  stub(HTMLCanvasElement.prototype, 'toBlob', { value: (cb: (blob: Blob) => void, type = 'image/png') => cb(new Blob([new Uint8Array([1])], { type })), writable: true });
  stub(Element.prototype, 'setPointerCapture', { value: () => {}, writable: true });
  stub(globalThis, 'Path2D', { value: class {}, writable: true });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  for (const restore of restores.splice(0).reverse()) restore();
});

async function open(props: Partial<React.ComponentProps<typeof ImageAnnotator>> = {}) {
  const events: string[] = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ImageAnnotator
        imageSrc="blob:shot"
        isOpen
        onAccept={async (_blob, hasDrawings) => void events.push(hasDrawings ? 'accept:drawn' : 'accept:empty')}
        onClose={() => events.push('close')}
        {...props}
      />,
    );
  });
  const stage = host.querySelector('[data-pn-image-annotator-stage]')!;
  await act(async () => stage.querySelector('img')!.dispatchEvent(new Event('load')));
  return events;
}

async function draw() {
  const canvas = host!.querySelector('[data-pn-image-annotator-stage] canvas')!;
  const at = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
  await act(async () => at('pointerdown', 5, 5));
  await act(async () => at('pointermove', 25, 15));
  await act(async () => at('pointerup', 25, 15));
}

const press = (key: string) => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
const backdrop = () => host!.querySelector<HTMLElement>('.pn-visible-viewport-overlay')!;
const clickOutside = () => act(async () => backdrop().dispatchEvent(new MouseEvent('click', { bubbles: true })));

test.skipIf(!hasDom)('by default (plan review) Escape accepts the drawing, under the hint that says so', async () => {
  const events = await open();
  expect(host!.querySelector('[data-pn-image-annotator-hint]')!.textContent).toBe('Press Esc or Enter or click outside to accept');
  expect(host!.querySelector('[data-pn-image-annotator-toolbar] button[title^="Save"]')!.getAttribute('title')).toBe('Save (Esc)');
  await draw();
  await press('Escape');
  expect(events).toEqual(['accept:drawn', 'close']);
});

test.skipIf(!hasDom)('by default a click outside accepts the drawing', async () => {
  const events = await open();
  await draw();
  await clickOutside();
  expect(events).toEqual(['accept:drawn', 'close']);
});

test.skipIf(!hasDom)('with escapeCancels, Escape closes and accepts nothing; Enter accepts', async () => {
  const events = await open({ escapeCancels: true, hint: 'Enter or ✓ adds to your reply · Esc cancels' });
  expect(host!.querySelector('[data-pn-image-annotator-hint]')!.textContent).toBe('Enter or ✓ adds to your reply · Esc cancels');
  // The ✓ no longer names Escape, which now cancels.
  expect(host!.querySelector('[data-pn-image-annotator-toolbar] button[title^="Save"]')!.getAttribute('title')).toBe('Save (Enter)');
  await draw();
  await press('Escape');
  expect(events).toEqual(['close']);
  events.length = 0;
  await draw();
  await press('Enter');
  expect(events).toEqual(['accept:drawn', 'close']);
});

test.skipIf(!hasDom)('with escapeCancels, a click outside keeps a drawing open and closes only an empty one', async () => {
  const events = await open({ escapeCancels: true });
  await draw();
  await clickOutside();
  expect(events).toEqual([]);
  expect(backdrop()).not.toBeNull();
  // Undo the stroke: now empty, a click outside closes without accepting.
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })));
  await clickOutside();
  expect(events).toEqual(['close']);
});
