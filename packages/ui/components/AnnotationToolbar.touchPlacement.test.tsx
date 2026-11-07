import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationToolbar } from './AnnotationToolbar';
import { resetTouchSelectionToolbar, setTouchSelectionToolbar } from '../utils/touchToolbarPlacement';

/**
 * The toolbar's touch placement is a host opt-in (`touchSelectionToolbar`):
 * with it on and a finger as the main pointer, the toolbar goes below the
 * selection, inside the screen, and is marked for theme.css's thumb-sized
 * buttons. A mouse, or a host that did not opt in (Workspaces), keeps the
 * centered-above toolbar exactly as before.
 */

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let anchor: HTMLElement | null = null;
let originalMatchMedia: typeof window.matchMedia | undefined;

function pointerMatchMedia(coarse: boolean) {
  return (query: string): MediaQueryList => ({
    matches: coarse ? query.includes('pointer: coarse') : query.includes('pointer: fine'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  anchor?.remove();
  anchor = null;
  resetTouchSelectionToolbar();
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  originalMatchMedia = undefined;
  if (hasDom) document.body.replaceChildren();
});

async function mount(opts: { optIn: boolean; coarse: boolean; rect: { left: number; top: number; width: number; height: number } }) {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = pointerMatchMedia(opts.coarse) as typeof window.matchMedia;
  if (opts.optIn) setTouchSelectionToolbar(true);
  anchor = document.createElement('span');
  anchor.textContent = 'selected words';
  const { left, top, width, height } = opts.rect;
  anchor.getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(anchor);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AnnotationToolbar
        element={anchor!}
        positionMode="center-above"
        onAnnotate={() => {}}
        onClose={() => {}}
        onRequestComment={() => {}}
        onQuickLabel={() => {}}
      />,
    );
  });
  const toolbar = document.querySelector<HTMLElement>('.annotation-toolbar');
  if (!toolbar) throw new Error('annotation toolbar did not render');
  return toolbar;
}

describe.if(hasDom)('AnnotationToolbar touch placement', () => {
  test('opted in on a touch screen: below the selection, inside the left edge, marked for thumb-sized buttons', async () => {
    const toolbar = await mount({ optIn: true, coarse: true, rect: { left: 2, top: 300, width: 24, height: 22 } });
    expect(toolbar.dataset.pnAnnotationToolbarTouch).toBe('below');
    expect(toolbar.dataset.pnAnnotationToolbarCentered).toBeUndefined();
    expect(toolbar.style.transform).toBe('');
    expect(parseFloat(toolbar.style.top)).toBeGreaterThan(322);
    expect(parseFloat(toolbar.style.left)).toBeGreaterThanOrEqual(8);
  });

  test('opted in with a mouse: the desktop toolbar, centered above', async () => {
    const toolbar = await mount({ optIn: true, coarse: false, rect: { left: 200, top: 300, width: 40, height: 22 } });
    expect(toolbar.dataset.pnAnnotationToolbarTouch).toBeUndefined();
    expect(toolbar.dataset.pnAnnotationToolbarCentered).toBe('true');
    expect(toolbar.style.top).toBe('252px');
    expect(toolbar.style.left).toBe('220px');
    expect(toolbar.style.transform).toBe('translateX(-50%)');
  });

  test('a host that did not opt in keeps the desktop toolbar on a touch screen', async () => {
    const toolbar = await mount({ optIn: false, coarse: true, rect: { left: 200, top: 300, width: 40, height: 22 } });
    expect(toolbar.dataset.pnAnnotationToolbarTouch).toBeUndefined();
    expect(toolbar.style.top).toBe('252px');
    expect(toolbar.style.transform).toBe('translateX(-50%)');
  });
});
