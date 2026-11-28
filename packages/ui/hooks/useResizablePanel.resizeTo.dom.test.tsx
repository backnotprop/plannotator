/**
 * resizeTo (keyboard resizing) ends where a finished drag ends: clamped to the
 * hook's min and max, applied, and saved under the drag's key in the drag's
 * format, so the next mount reads it back. Requires DOM (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, type PointerEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useResizablePanel') : null;
const storage = hasDom ? await import('../utils/storage') : null;

type Panel = ReturnType<NonNullable<typeof hookModule>['useResizablePanel']>;

const KEY = 'resize-to-test-width';
const LIMITS = { storageKey: KEY, defaultWidth: 300, minWidth: 200, maxWidth: 500 } as const;

let roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
  storage?.resetStorageBackend();
});

function memoryBackend() {
  const memory = new Map<string, string>();
  storage!.setStorageBackend({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
    removeItem: (key) => void memory.delete(key),
  });
  return memory;
}

function mountPanel(apply?: (width: number) => void): { current: Panel } {
  const ref = { current: null as unknown as Panel };
  function Harness() {
    ref.current = hookModule!.useResizablePanel({ ...LIMITS, side: 'left', apply });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => root.render(<Harness />));
  return ref;
}

/**
 * A drag on the handle: pointer down, move by `dx`, then the one animation
 * frame the move asked for, run by hand so the test does not depend on the
 * DOM's frame timing, then pointer up. Returns the widths the frame applied.
 */
function drag(panel: { current: Panel }, dx: number, applied: number[]) {
  const frames: FrameRequestCallback[] = [];
  const realFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  try {
    act(() => panel.current.handleProps.onPointerDown({ button: 0, clientX: 100, clientY: 0, preventDefault() {} } as unknown as PointerEvent));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100 + dx, clientY: 0 }));
    });
    expect(frames.length).toBe(1);
    act(() => frames.shift()!(0));
    expect(applied.at(-1)).toBe(300 + dx);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 100 + dx, clientY: 0 }));
    });
  } finally {
    globalThis.requestAnimationFrame = realFrame;
  }
}

describe.if(hasDom)('useResizablePanel resizeTo', () => {
  test('clamps below min and above max, and applies each width', () => {
    memoryBackend();
    const applied: number[] = [];
    const panel = mountPanel((width) => applied.push(width));
    act(() => panel.current.resizeTo(50));
    expect(panel.current.width).toBe(200);
    act(() => panel.current.resizeTo(9_999));
    expect(panel.current.width).toBe(500);
    act(() => panel.current.resizeTo(321));
    expect(panel.current.width).toBe(321);
    expect(applied).toEqual([200, 500, 321]);
  });

  test('saves under the key and in the format a finished drag uses, and a second instance reads it back', () => {
    const memory = memoryBackend();
    const applied: number[] = [];
    const panel = mountPanel((width) => applied.push(width));
    drag(panel, 40, applied);
    expect([...memory.entries()]).toEqual([[KEY, '340']]);
    act(() => panel.current.resizeTo(410));
    expect([...memory.entries()]).toEqual([[KEY, '410']]);
    expect(mountPanel().current.width).toBe(410);
  });

  test('a width that is not a number is ignored: nothing applied, nothing saved', () => {
    const memory = memoryBackend();
    const applied: number[] = [];
    const panel = mountPanel((width) => applied.push(width));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) act(() => panel.current.resizeTo(bad));
    expect(panel.current.width).toBe(300);
    expect(applied).toEqual([]);
    expect(memory.size).toBe(0);
  });

  test('a hook nobody calls resizeTo on saves nothing and keeps its default', () => {
    const memory = memoryBackend();
    const panel = mountPanel();
    expect(panel.current.width).toBe(300);
    expect(memory.size).toBe(0);
  });
});
