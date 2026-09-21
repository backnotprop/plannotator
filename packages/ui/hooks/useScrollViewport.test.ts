import { describe, expect, test } from 'bun:test';
import {
  addScrollViewportListener,
  getDocumentScrollViewport,
  getScrollViewportIntersectionRoot,
  getScrollViewportRect,
  isDocumentScrollViewport,
} from './useScrollViewport';

const hasDom = typeof document !== 'undefined';

describe.skipIf(!hasDom)('document scroll viewport', () => {
  test('distinguishes the page scroller from an element scroller', () => {
    const documentViewport = getDocumentScrollViewport();
    const elementViewport = document.createElement('main');

    expect(documentViewport).not.toBeNull();
    expect(isDocumentScrollViewport(documentViewport)).toBe(true);
    expect(isDocumentScrollViewport(elementViewport)).toBe(false);
    expect(getScrollViewportIntersectionRoot(documentViewport!)).toBeNull();
    expect(getScrollViewportIntersectionRoot(elementViewport)).toBe(elementViewport);
  });

  test('keeps element viewport geometry unchanged', () => {
    const elementViewport = document.createElement('main');
    const rect = new DOMRect(12, 24, 320, 480);
    elementViewport.getBoundingClientRect = () => rect;

    expect(getScrollViewportRect(elementViewport)).toBe(rect);
  });

  test('uses Visual Viewport geometry for the page instead of the full document rect', () => {
    const documentViewport = getDocumentScrollViewport();
    expect(documentViewport).not.toBeNull();
    const previous = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 390,
        height: 510,
        offsetLeft: 0,
        offsetTop: 44,
      },
    });

    try {
      const rect = getScrollViewportRect(documentViewport!);
      expect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }).toEqual({
        left: 0,
        top: 44,
        width: 390,
        height: 510,
      });
    } finally {
      if (previous) Object.defineProperty(window, 'visualViewport', previous);
      else delete (window as Window & { visualViewport?: VisualViewport }).visualViewport;
    }
  });

  test('listens to window scrolling for the page viewport', () => {
    const documentViewport = getDocumentScrollViewport();
    expect(documentViewport).not.toBeNull();

    let calls = 0;
    const remove = addScrollViewportListener(documentViewport!, () => { calls += 1; });
    window.dispatchEvent(new Event('scroll'));
    remove();
    window.dispatchEvent(new Event('scroll'));

    expect(calls).toBe(1);
  });
});
