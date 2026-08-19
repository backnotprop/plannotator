import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  calculateVisibleViewportBounds,
  calculateViewportEnvironment,
  shouldUseExpandedComposer,
  useViewportEnvironment,
} from './useViewportEnvironment';

const hasDom = typeof document !== 'undefined';
const VIEWPORT_PROPERTIES = [
  '--pn-viewport-width',
  '--pn-viewport-height',
  '--pn-viewport-offset-top',
  '--pn-viewport-offset-left',
  '--pn-keyboard-inset',
] as const;

let roots: Root[] = [];
let hosts: HTMLElement[] = [];

function Harness() {
  useViewportEnvironment();
  return null;
}

async function mountHarness(): Promise<Root> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<Harness />));
  return root;
}

describe('calculateViewportEnvironment', () => {
  test('uses the layout viewport when the Visual Viewport API is unavailable', () => {
    expect(calculateViewportEnvironment({ layoutWidth: 390, layoutHeight: 844 })).toEqual({
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      keyboardInset: 0,
    });
  });

  test('tracks browser chrome and keyboard obstruction', () => {
    expect(calculateViewportEnvironment({
      layoutWidth: 390,
      layoutHeight: 844,
      visualViewport: {
        width: 390,
        height: 510,
        offsetTop: 44,
        offsetLeft: 0,
        scale: 1,
      },
    })).toEqual({
      width: 390,
      height: 510,
      offsetTop: 44,
      offsetLeft: 0,
      keyboardInset: 290,
    });
  });

  test('keeps layout geometry stable during pinch zoom', () => {
    expect(calculateViewportEnvironment({
      layoutWidth: 390,
      layoutHeight: 844,
      visualViewport: {
        width: 195,
        height: 422,
        offsetTop: 100,
        offsetLeft: 50,
        scale: 2,
      },
    })).toEqual({
      width: 390,
      height: 844,
      offsetTop: 100,
      offsetLeft: 50,
      keyboardInset: 0,
    });
  });

  test('clamps invalid and off-layout geometry', () => {
    expect(calculateViewportEnvironment({
      layoutWidth: 320,
      layoutHeight: 568,
      visualViewport: {
        width: Number.NaN,
        height: 900,
        offsetTop: 100,
        offsetLeft: -10,
        scale: 0,
      },
    })).toEqual({
      width: 320,
      height: 468,
      offsetTop: 100,
      offsetLeft: 0,
      keyboardInset: 0,
    });
  });
});

describe('calculateVisibleViewportBounds', () => {
  test('applies viewport offsets, safe insets, and edge padding', () => {
    expect(calculateVisibleViewportBounds(
      {
        width: 390,
        height: 510,
        offsetTop: 44,
        offsetLeft: 0,
        keyboardInset: 290,
      },
      16,
      { top: 3, right: 4, bottom: 5, left: 6 },
    )).toEqual({
      top: 63,
      right: 370,
      bottom: 533,
      left: 22,
      width: 348,
      height: 470,
    });
  });

  test('clamps over-constrained bounds without producing negative dimensions', () => {
    expect(calculateVisibleViewportBounds(
      {
        width: 24,
        height: 20,
        offsetTop: 8,
        offsetLeft: 4,
        keyboardInset: 0,
      },
      16,
    )).toEqual({
      top: 24,
      right: 20,
      bottom: 24,
      left: 20,
      width: 0,
      height: 0,
    });
  });

  test('expands composition only for touch, compact width, or short keyboard geometry', () => {
    const desktopBounds = calculateVisibleViewportBounds({
      width: 1280,
      height: 720,
      offsetTop: 0,
      offsetLeft: 0,
      keyboardInset: 0,
    });
    expect(shouldUseExpandedComposer({ bounds: desktopBounds, coarsePointer: false })).toBe(false);
    expect(shouldUseExpandedComposer({ bounds: desktopBounds, coarsePointer: true })).toBe(true);
    expect(shouldUseExpandedComposer({
      bounds: { ...desktopBounds, width: 639 },
      coarsePointer: false,
    })).toBe(true);
    expect(shouldUseExpandedComposer({
      bounds: { ...desktopBounds, height: 419 },
      coarsePointer: false,
    })).toBe(true);
  });
});

describe('useViewportEnvironment', () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    for (const host of hosts.splice(0)) host.remove();
    if (hasDom) {
      for (const property of VIEWPORT_PROPERTIES) {
        document.documentElement.style.removeProperty(property);
      }
      document.body.replaceChildren();
    }
  });

  test.skipIf(!hasDom)('publishes and restores the shared CSS contract', async () => {
    document.documentElement.style.setProperty('--pn-viewport-width', '777px');
    const root = await mountHarness();

    expect(document.documentElement.style.getPropertyValue('--pn-viewport-width')).toBe(`${window.innerWidth}px`);
    expect(document.documentElement.style.getPropertyValue('--pn-viewport-height')).toBe(`${window.innerHeight}px`);

    await act(async () => root.unmount());
    roots = roots.filter((candidate) => candidate !== root);
    expect(document.documentElement.style.getPropertyValue('--pn-viewport-width')).toBe('777px');
    expect(document.documentElement.style.getPropertyValue('--pn-viewport-height')).toBe('');
  });

  test.skipIf(!hasDom)('keeps the observer alive until the final consumer unmounts', async () => {
    const first = await mountHarness();
    const second = await mountHarness();

    await act(async () => first.unmount());
    roots = roots.filter((candidate) => candidate !== first);
    expect(document.documentElement.style.getPropertyValue('--pn-viewport-height')).toBe(`${window.innerHeight}px`);

    await act(async () => second.unmount());
    roots = roots.filter((candidate) => candidate !== second);
    expect(document.documentElement.style.getPropertyValue('--pn-viewport-height')).toBe('');
  });

  test.skipIf(!hasDom)('coalesces Visual Viewport events and removes their listeners', async () => {
    class FakeVisualViewport extends EventTarget {
      width = window.innerWidth;
      height = window.innerHeight;
      offsetTop = 0;
      offsetLeft = 0;
      scale = 1;
    }

    const fakeViewport = new FakeVisualViewport();
    const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const frames: FrameRequestCallback[] = [];

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: fakeViewport,
    });
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    };
    window.cancelAnimationFrame = () => {};

    try {
      const root = await mountHarness();
      fakeViewport.height = window.innerHeight - 120;
      fakeViewport.dispatchEvent(new Event('resize'));
      fakeViewport.dispatchEvent(new Event('scroll'));
      expect(frames).toHaveLength(1);

      frames.shift()?.(performance.now());
      expect(document.documentElement.style.getPropertyValue('--pn-viewport-height')).toBe(`${window.innerHeight - 120}px`);
      expect(document.documentElement.style.getPropertyValue('--pn-keyboard-inset')).toBe('120px');

      await act(async () => root.unmount());
      roots = roots.filter((candidate) => candidate !== root);
      fakeViewport.dispatchEvent(new Event('resize'));
      expect(frames).toHaveLength(0);
    } finally {
      if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
      else delete (window as Window & { visualViewport?: VisualViewport }).visualViewport;
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });
});
