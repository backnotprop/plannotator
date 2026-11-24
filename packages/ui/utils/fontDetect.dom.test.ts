/**
 * WebKit's canvas can measure an installed family at the fallback width while
 * DOM text renders it in that family. Glimpse uses WKWebView, so the Settings
 * hint must trust the DOM measurement that actually paints the document.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { isFontInstalled } from './fontDetect';

const hasDom = typeof document !== 'undefined';
const originalCreate = hasDom ? document.createElement : null;

function stubCanvas(width: number) {
  const canvas = globalThis.HTMLCanvasElement as typeof HTMLCanvasElement | undefined;
  if (!canvas) return;
  const original = canvas.prototype.getContext;
  canvas.prototype.getContext = (() => ({ font: '', measureText: () => ({ width }) })) as unknown as typeof canvas.prototype.getContext;
  return () => { canvas.prototype.getContext = original; };
}

function stubProbe(widthForFamily: (family: string) => number) {
  const probe = originalCreate!.call(document, 'span');
  let removed = false;
  const realRemove = probe.remove.bind(probe);
  probe.getBoundingClientRect = () => ({ width: widthForFamily(probe.style.fontFamily) }) as DOMRect;
  probe.remove = () => { removed = true; realRemove(); };
  document.createElement = ((tag: string) => (tag === 'span' ? probe : originalCreate!.call(document, tag))) as typeof document.createElement;
  return () => removed;
}

afterEach(() => {
  if (!hasDom) return;
  document.createElement = originalCreate!;
  document.body.replaceChildren();
});

describe.if(hasDom)('font detection with WebKit-style canvas measurements', () => {
  test('a family the DOM resolves is found even when canvas reports only the fallback', () => {
    const restoreCanvas = stubCanvas(100);
    const didRemove = stubProbe((family) => (family.startsWith('"Nebula Sans"') ? 150 : 100));
    try {
      expect(isFontInstalled('Nebula Sans')).toBe(true);
      expect(didRemove()).toBe(true);
    } finally {
      restoreCanvas?.();
    }
  });

  test('a family that never changes the measured width is not found', () => {
    const restoreCanvas = stubCanvas(100);
    stubProbe(() => 100);
    try {
      expect(isFontInstalled('No Such Font')).toBe(false);
    } finally {
      restoreCanvas?.();
    }
  });
});
