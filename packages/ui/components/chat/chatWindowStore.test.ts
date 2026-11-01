import { afterEach, describe, expect, test } from 'bun:test';

import {
  CHAT_WINDOW_DEFAULT,
  CHAT_WINDOW_FRAME_MARGIN,
  CHAT_WINDOW_MIN,
  ChatWindowStore,
  type ChatWindowGeometry,
} from './chatWindowStore';

const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const realLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const realSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

afterEach(() => {
  restoreGlobal('window', realWindow);
  restoreGlobal('localStorage', realLocal);
  restoreGlobal('sessionStorage', realSession);
});

function viewport(innerWidth: number, innerHeight: number) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { innerWidth, innerHeight },
  });
}

describe('saved geometry coming in', () => {
  test('a saved geometry that fits is taken as it is', () => {
    viewport(1600, 1000);
    const store = new ChatWindowStore({ initialGeometry: { w: 500, h: 600, right: 40, bottom: 50 } });
    expect(store.geometry()).toEqual({ w: 500, h: 600, right: 40, bottom: 50 });
  });

  test('a window saved on a bigger screen is held to this viewport', () => {
    viewport(1000, 700);
    const store = new ChatWindowStore({ initialGeometry: { w: 3000, h: 2000, right: 2000, bottom: 2000 } });
    expect(store.geometry()).toEqual({
      w: 1000 - CHAT_WINDOW_FRAME_MARGIN * 2,
      h: 700 - CHAT_WINDOW_FRAME_MARGIN * 2,
      right: CHAT_WINDOW_FRAME_MARGIN * 2,
      bottom: CHAT_WINDOW_FRAME_MARGIN * 2,
    });
  });

  test('a size under the minimum is raised to it', () => {
    viewport(1600, 1000);
    const store = new ChatWindowStore({ initialGeometry: { w: 10, h: 10, right: 0, bottom: 0 } });
    expect(store.winW).toBe(CHAT_WINDOW_MIN.width);
    expect(store.winH).toBe(CHAT_WINDOW_MIN.height);
  });

  test('a corrupted value falls back to the default dock, field by field', () => {
    viewport(1600, 1000);
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

describe('clamp to the measured frame', () => {
  test('a frame that shrinks pulls the window back inside it', () => {
    viewport(1600, 1000);
    const store = new ChatWindowStore({ initialGeometry: { w: 900, h: 800, right: 300, bottom: 150 } });
    store.clampToFrame(800, 600);
    expect(store.geometry()).toEqual({
      w: 800 - CHAT_WINDOW_FRAME_MARGIN * 2,
      h: 600 - CHAT_WINDOW_FRAME_MARGIN * 2,
      right: CHAT_WINDOW_FRAME_MARGIN * 2,
      bottom: CHAT_WINDOW_FRAME_MARGIN * 2,
    });
  });

  test('the minimum holds even in a frame smaller than it', () => {
    const store = new ChatWindowStore();
    store.clampToFrame(300, 300);
    expect(store.winW).toBe(CHAT_WINDOW_MIN.width);
    expect(store.winH).toBe(CHAT_WINDOW_MIN.height);
    expect(store.winRight).toBe(0);
    expect(store.winBottom).toBe(0);
  });

  test('an unmeasurable frame changes nothing', () => {
    const store = new ChatWindowStore();
    const before = store.getVersion();
    store.clampToFrame(0, 0);
    expect(store.getVersion()).toBe(before);
  });

  test('a window that already fits does not notify listeners', () => {
    const store = new ChatWindowStore();
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    store.clampToFrame(1200, 900);
    expect(heard).toBe(0);
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
    store.clampToFrame(450, 500);
    expect(reports).toEqual([
      { w: 500, h: 601, right: 16, bottom: 16 },
      { w: 500, h: 601, right: 30, bottom: 40 },
      { w: 500, h: 601, right: 16, bottom: 16 },
      { w: 418, h: 468, right: 16, bottom: 16 },
    ]);
  });

  test('what it reports comes back as the same window', () => {
    viewport(1600, 1000);
    let saved: ChatWindowGeometry | undefined;
    const first = new ChatWindowStore({ onGeometryChange: (geometry) => (saved = geometry) });
    first.setWindowSize(512, 640);
    first.setWindowOffsets(64, 80);
    expect(new ChatWindowStore({ initialGeometry: saved }).geometry()).toEqual(first.geometry());
  });

  test('taking a saved value and non-geometry changes report nothing', () => {
    viewport(1600, 1000);
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

  test('the store never touches storage', () => {
    viewport(1600, 1000);
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
    store.clampToFrame(500, 500);
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

  test('fullscreen from minimized opens the window', () => {
    const store = new ChatWindowStore();
    store.toggleFullscreen();
    expect(store.fullscreen).toBe(true);
    expect(store.minimized).toBe(false);
  });
});
