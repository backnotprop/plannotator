import { afterEach, describe, expect, test } from 'bun:test';

import {
  CHAT_WINDOW_DEFAULT,
  CHAT_WINDOW_FRAME_MARGIN,
  CHAT_WINDOW_MIN,
  ChatWindowStore,
  fitChatWindow,
  type ChatWindowGeometry,
} from './chatWindowStore';

const realLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const realSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

afterEach(() => {
  restoreGlobal('localStorage', realLocal);
  restoreGlobal('sessionStorage', realSession);
});

describe('saved geometry coming in', () => {
  test('a saved geometry is taken as it is', () => {
    const store = new ChatWindowStore({ initialGeometry: { w: 500, h: 600, right: 40, bottom: 50 } });
    expect(store.geometry()).toEqual({ w: 500, h: 600, right: 40, bottom: 50 });
  });

  test('a window saved on a bigger screen keeps the size the person chose', () => {
    const saved = { w: 3000, h: 2000, right: 2000, bottom: 2000 };
    expect(new ChatWindowStore({ initialGeometry: saved }).geometry()).toEqual(saved);
  });

  test('a size under the minimum is raised to it', () => {
    const store = new ChatWindowStore({ initialGeometry: { w: 10, h: 10, right: 0, bottom: 0 } });
    expect(store.winW).toBe(CHAT_WINDOW_MIN.width);
    expect(store.winH).toBe(CHAT_WINDOW_MIN.height);
  });

  test('a corrupted value falls back to the default dock, field by field', () => {
    for (const saved of [null, 'oops', 7, { w: 'wide', h: Number.NaN, right: null, bottom: Infinity }]) {
      const store = new ChatWindowStore({ initialGeometry: saved });
      expect(store.geometry()).toEqual({
        w: CHAT_WINDOW_DEFAULT.width,
        h: CHAT_WINDOW_DEFAULT.height,
        right: CHAT_WINDOW_DEFAULT.right,
        bottom: CHAT_WINDOW_DEFAULT.bottom,
      });
    }
  });
});

describe('fitting a chosen window to the measured frame', () => {
  const chosen = { w: 900, h: 800, right: 300, bottom: 150 };

  test('a window too big for the frame draws inside it', () => {
    expect(fitChatWindow(chosen, { width: 800, height: 600 })).toEqual({
      w: 800 - CHAT_WINDOW_FRAME_MARGIN * 2,
      h: 600 - CHAT_WINDOW_FRAME_MARGIN * 2,
      right: CHAT_WINDOW_FRAME_MARGIN * 2,
      bottom: CHAT_WINDOW_FRAME_MARGIN * 2,
    });
  });

  test('a window that fits draws as chosen', () => {
    expect(fitChatWindow(chosen, { width: 2000, height: 1200 })).toEqual(chosen);
  });

  test('the minimum holds even in a frame smaller than it, with the offsets at zero', () => {
    expect(fitChatWindow(chosen, { width: 300, height: 300 })).toEqual({
      w: CHAT_WINDOW_MIN.width,
      h: CHAT_WINDOW_MIN.height,
      right: 0,
      bottom: 0,
    });
  });
});

describe('re-dock', () => {
  test('goes back to the default offsets and keeps the size', () => {
    const store = new ChatWindowStore();
    store.setWindowSize(500, 600);
    store.setWindowOffsets(200, 300);
    store.resetWindowDock();
    expect(store.geometry()).toEqual({
      w: 500,
      h: 600,
      right: CHAT_WINDOW_DEFAULT.right,
      bottom: CHAT_WINDOW_DEFAULT.bottom,
    });
  });
});

describe('the host owns saved geometry', () => {
  test('each change reports the new geometry through the callback', () => {
    const reports: ChatWindowGeometry[] = [];
    const store = new ChatWindowStore({ onGeometryChange: (geometry) => reports.push(geometry) });
    store.setWindowSize(500.4, 600.6);
    store.setWindowOffsets(30, 40);
    store.resetWindowDock();
    expect(reports).toEqual([
      { w: 500, h: 601, right: 16, bottom: 16 },
      { w: 500, h: 601, right: 30, bottom: 40 },
      { w: 500, h: 601, right: 16, bottom: 16 },
    ]);
  });

  test('what it reports comes back as the same window', () => {
    let saved: ChatWindowGeometry | undefined;
    const first = new ChatWindowStore({ onGeometryChange: (geometry) => (saved = geometry) });
    first.setWindowSize(512, 640);
    first.setWindowOffsets(64, 80);
    expect(new ChatWindowStore({ initialGeometry: saved }).geometry()).toEqual(first.geometry());
  });

  test('taking a saved value and non-geometry changes report nothing', () => {
    const reports: ChatWindowGeometry[] = [];
    const store = new ChatWindowStore({
      initialGeometry: { w: 500, h: 600, right: 40, bottom: 50 },
      onGeometryChange: (geometry) => reports.push(geometry),
    });
    store.restore({ w: 510, h: 610, right: 41, bottom: 51 });
    store.setMinimized(false);
    store.toggleFullscreen();
    store.setWindowSize(store.winW, store.winH);
    expect(reports).toEqual([]);
  });

  test('a saved value taken while open tells listeners, so the window redraws', () => {
    const store = new ChatWindowStore();
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    store.restore({ w: 510, h: 610, right: 41, bottom: 51 });
    expect(heard).toBe(1);
  });

  test('the store never touches storage', () => {
    let touched = 0;
    const trap = () =>
      new Proxy(
        {},
        {
          get() {
            touched += 1;
            return () => null;
          },
        },
      );
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: trap() });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: trap() });

    const store = new ChatWindowStore({
      initialGeometry: { w: 500, h: 600, right: 40, bottom: 50 },
      onGeometryChange: () => {},
    });
    store.restore({ w: 510, h: 610, right: 41, bottom: 51 });
    store.setMinimized(false);
    store.toggleFullscreen();
    store.setWindowSize(520, 620);
    store.setWindowOffsets(60, 70);
    store.resetWindowDock();
    store.setMinimized(true);

    expect(touched).toBe(0);
  });
});

describe('open and minimized', () => {
  test('starts minimized; opening marks it and runs onOpen before listeners hear of it', () => {
    const order: string[] = [];
    const store = new ChatWindowStore({ onOpen: () => order.push('open') });
    store.subscribe(() => order.push('listener'));
    expect(store.minimized).toBe(true);
    expect(store.openedOnce).toBe(false);
    store.setMinimized(false);
    expect(store.minimized).toBe(false);
    expect(store.openedOnce).toBe(true);
    expect(order).toEqual(['open', 'listener']);
  });

  test('fullscreen from minimized is an open like any other', () => {
    const order: string[] = [];
    const store = new ChatWindowStore({ onOpen: () => order.push('open') });
    store.subscribe(() => order.push('listener'));
    store.toggleFullscreen();
    expect(store.fullscreen).toBe(true);
    expect(store.minimized).toBe(false);
    expect(store.openedOnce).toBe(true);
    expect(order).toEqual(['open', 'listener']);
  });

  test('summoned while it was left fullscreen, it stays fullscreen', () => {
    const store = new ChatWindowStore();
    store.toggleFullscreen();
    store.setMinimized(true);
    store.toggleFullscreen();
    expect(store.fullscreen).toBe(true);
    expect(store.minimized).toBe(false);
  });

  test('on an open window it toggles, and opens nothing', () => {
    let opened = 0;
    const store = new ChatWindowStore({ onOpen: () => (opened += 1) });
    store.setMinimized(false);
    store.toggleFullscreen();
    store.toggleFullscreen();
    expect(store.fullscreen).toBe(false);
    expect(opened).toBe(1);
  });
});
