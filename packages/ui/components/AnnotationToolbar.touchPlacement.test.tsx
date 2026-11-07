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
const restorers: Array<() => void> = [];

/** Replace a property for one test; afterEach puts the original back. */
function stubProperty(target: object, key: string, descriptor: PropertyDescriptor) {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restorers.push(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<string, unknown>)[key];
  });
}

/** A 390x844 phone screen with no visual viewport object, and a toolbar that measures `width` x 54. */
function phoneScreen(width: number) {
  stubProperty(window, 'innerWidth', { value: 390 });
  stubProperty(window, 'innerHeight', { value: 844 });
  stubProperty(window, 'visualViewport', { value: null });
  const measured = (size: number) => function (this: HTMLElement) {
    return this.classList?.contains('annotation-toolbar') ? size : 0;
  };
  stubProperty(HTMLElement.prototype, 'offsetWidth', { get: measured(width) });
  stubProperty(HTMLElement.prototype, 'offsetHeight', { get: measured(54) });
}

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
  while (restorers.length) restorers.pop()!();
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  originalMatchMedia = undefined;
  if (hasDom) document.body.replaceChildren();
});

async function mount(opts: {
  optIn: boolean;
  coarse: boolean;
  rect: { left: number; top: number; width: number; height: number };
  touchAnchorRect?: () => { top: number; bottom: number; left: number; right: number } | null;
  closeOnScrollOut?: boolean;
  onClose?: () => void;
  onRequestComment?: (initialChar?: string) => void;
}) {
  originalMatchMedia ??= window.matchMedia;
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
        onClose={opts.onClose ?? (() => {})}
        onRequestComment={opts.onRequestComment ?? (() => {})}
        onQuickLabel={() => {}}
        touchAnchorRect={opts.touchAnchorRect}
        closeOnScrollOut={opts.closeOnScrollOut}
      />,
    );
  });
  const toolbar = document.querySelector<HTMLElement>('.annotation-toolbar');
  if (!toolbar) throw new Error('annotation toolbar did not render');
  return toolbar;
}

describe.if(hasDom)('AnnotationToolbar touch placement', () => {
  test('opted in on a touch screen: docked to the bottom edge, centered, marked for thumb-sized buttons', async () => {
    phoneScreen(276);
    const toolbar = await mount({ optIn: true, coarse: true, rect: { left: 2, top: 300, width: 24, height: 22 } });
    expect(toolbar.dataset.pnAnnotationToolbarTouch).toBe('dock-bottom');
    expect(toolbar.dataset.pnAnnotationToolbarCentered).toBeUndefined();
    expect(toolbar.style.transform).toBe('');
    expect(parseFloat(toolbar.style.top)).toBe(844 - 8 - 54);
    expect(parseFloat(toolbar.style.left)).toBe((390 - 276) / 2);
  });

  test('a selection whose last piece reaches the bottom band docks it to the top (whole selection, not element)', async () => {
    phoneScreen(276);
    const toolbar = await mount({
      optIn: true,
      coarse: true,
      // `element` is the first mark, high up; the selection ends near the bottom.
      rect: { left: 300, top: 400, width: 70, height: 22 },
      touchAnchorRect: () => ({ left: 16, right: 370, top: 400, bottom: 790 }),
    });
    expect(toolbar.dataset.pnAnnotationToolbarTouch).toBe('dock-top');
    expect(parseFloat(toolbar.style.top)).toBe(8);
  });

  test('placed from its measured size: a 300px toolbar is centered by its real width', async () => {
    // Wider than the first estimate, so only the measure-and-re-place pass gets this right.
    phoneScreen(300);
    const toolbar = await mount({ optIn: true, coarse: true, rect: { left: 350, top: 300, width: 30, height: 22 } });
    expect(parseFloat(toolbar.style.left)).toBe((390 - 300) / 2);
    expect(parseFloat(toolbar.style.maxWidth)).toBe(390 - 16);
  });

  test('a selection scrolled out of sight hides the toolbar instead of pinning it to an edge', async () => {
    phoneScreen(276);
    const toolbar = await mount({ optIn: true, coarse: true, rect: { left: 100, top: -300, width: 30, height: 22 } });
    expect(toolbar.dataset.pnAnnotationToolbarTouch).toBe('hidden');
    expect(toolbar.style.visibility).toBe('hidden');
  });

  test('a tall selection whose first line scrolled above the top stays open: it closes by the whole selection', async () => {
    phoneScreen(276);
    let closes = 0;
    const toolbar = await mount({
      optIn: true,
      coarse: true,
      closeOnScrollOut: true,
      onClose: () => { closes += 1; },
      // The first mark is above the screen; the selection runs down to 400.
      rect: { left: 40, top: -100, width: 200, height: 22 },
      touchAnchorRect: () => ({ left: 16, right: 370, top: -100, bottom: 400 }),
    });
    expect(closes).toBe(0);
    expect(toolbar.dataset.pnAnnotationToolbarTouch).toBe('dock-bottom');
  });

  test('while hidden its keys act on nothing; shown, a typed letter starts a comment', async () => {
    phoneScreen(276);
    const typed: Array<string | undefined> = [];
    await mount({
      optIn: true,
      coarse: true,
      onRequestComment: (c) => { typed.push(c); },
      rect: { left: 100, top: -300, width: 30, height: 22 },
    });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); });
    expect(typed).toEqual([]);
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    await mount({
      optIn: true,
      coarse: true,
      onRequestComment: (c) => { typed.push(c); },
      rect: { left: 100, top: 300, width: 30, height: 22 },
    });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); });
    expect(typed).toEqual(['a']);
  });

  test('opted in with a mouse: the desktop toolbar, centered above', async () => {
    const toolbar = await mount({ optIn: true, coarse: false, rect: { left: 200, top: 300, width: 40, height: 22 } });
    expect(toolbar.dataset.pnAnnotationToolbarTouch).toBeUndefined();
    expect(toolbar.dataset.pnAnnotationToolbarCentered).toBe('true');
    expect(toolbar.style.top).toBe('252px');
    expect(toolbar.style.left).toBe('220px');
    expect(toolbar.style.transform).toBe('translateX(-50%)');
    expect(toolbar.style.maxWidth).toBe('');
  });

  test('a host that did not opt in keeps the desktop toolbar on a touch screen', async () => {
    const toolbar = await mount({ optIn: false, coarse: true, rect: { left: 200, top: 300, width: 40, height: 22 } });
    expect(toolbar.dataset.pnAnnotationToolbarTouch).toBeUndefined();
    expect(toolbar.style.top).toBe('252px');
    expect(toolbar.style.transform).toBe('translateX(-50%)');
  });
});
