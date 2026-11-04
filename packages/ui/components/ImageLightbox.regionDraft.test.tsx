/**
 * The image-region composer keeps the words typed (DOM-gated), driven through
 * the REAL Viewer, lightbox and comment composer as in
 * Viewer.imageRegions.test.tsx (happy-dom lays nothing out, so the stage's box
 * and the image's own size are given).
 *
 * What regresses: Escape on the region composer throwing the words away, so
 * drawing the same box again shows an empty box; one box's words showing up
 * on another box; Save leaving the words behind.
 */
import { afterEach, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const MARKDOWN = ['# Status colors', '', '![Job status colors](figures/status-colors.png)', ''].join('\n');
const STAGE = { left: 0, top: 0, width: 1000, height: 600 };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function mountHost() {
  const Viewer = viewerModule!.Viewer;
  const state: { annotations: Annotation[] } = { annotations: [] };
  function Host() {
    const [annotations, setAnnotations] = useState<Annotation[]>([]);
    state.annotations = annotations;
    const blocks = parserModule!.parseMarkdownToBlocks(MARKDOWN);
    return (
      <Viewer
        blocks={blocks}
        markdown={MARKDOWN}
        annotations={annotations}
        onAddAnnotation={(a) => setAnnotations((list) => [...list, a])}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        imageLightboxStepping
        imageRegionComments
      />
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Host />);
  });
  await settle();
  return state;
}

/** Open the viewer, give the stage a box and the image its own size (2000 × 1000; Fit is 50%), turn on Region. */
async function openRegionTool(): Promise<HTMLElement> {
  const image = document.querySelector<HTMLImageElement>('article img.cursor-zoom-in')!;
  await act(async () => image.click());
  await settle();
  const stage = document.querySelector<HTMLElement>('[data-lightbox-stage]')!;
  stage.getBoundingClientRect = () =>
    ({ ...STAGE, right: STAGE.width, bottom: STAGE.height, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const img = stage.querySelector<HTMLImageElement>('[data-lightbox-image]')!;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 2000 });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1000 });
  await act(async () => { img.dispatchEvent(new Event('load')); });
  const region = document.querySelector<HTMLButtonElement>('[data-region-tool="region"]')!;
  await act(async () => region.click());
  return stage;
}

async function pointer(target: HTMLElement, type: string, x: number, y: number) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, button: 0, pointerType: 'mouse', bubbles: true, cancelable: true }));
  });
}

/** Drag a box on the stage; the region composer opens on it. */
async function drawBox(stage: HTMLElement, from: [number, number], to: [number, number]): Promise<HTMLTextAreaElement> {
  await pointer(stage, 'pointerdown', from[0], from[1]);
  await pointer(stage, 'pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  await pointer(stage, 'pointermove', to[0], to[1]);
  await pointer(stage, 'pointerup', to[0], to[1]);
  await settle();
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('region composer missing');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

test.skipIf(!hasDom)('Escape keeps the words for this box, drawing it again restores them, Save clears them', async () => {
  const state = await mountHost();
  const stage = await openRegionTool();

  await type(await drawBox(stage, [100, 150], [300, 250]), 'the paused box should be grey');
  await press(document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!, 'Escape');
  expect(document.querySelector('[data-comment-popover]')).toBeNull();
  expect(document.querySelector('[data-image-lightbox]')).not.toBeNull();

  // Another box starts empty.
  const other = await drawBox(stage, [500, 150], [600, 250]);
  expect(other.value).toBe('');
  await press(other, 'Escape');

  // The same box again: the words come back.
  const back = await drawBox(stage, [100, 150], [300, 250]);
  expect(back.value).toBe('the paused box should be grey');

  await press(back, 'Enter', { metaKey: true });
  expect(state.annotations.map((a) => a.text)).toEqual(['the paused box should be grey']);
  expect((await drawBox(stage, [100, 150], [300, 250])).value).toBe('');
});
