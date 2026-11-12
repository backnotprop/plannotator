import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHONE_QUERY, isIOSWebKit, keyboardInset, keyboardLayout, stripHeight, trackKeyboard } from './phone';

describe('the keyboard on a phone', () => {
  test('the keyboard up, unzoomed: the window takes the height above it and undoes the pan', () => {
    expect(keyboardLayout({ height: 400, offsetTop: 120, scale: 1 }, 659, 0, true)).toEqual({ height: 400, resetScroll: true });
    expect(keyboardLayout({ height: 400.4, offsetTop: 0, scale: 1 }, 659, 0, true)).toEqual({ height: 400, resetScroll: false });
  });

  test('pinch-zoomed to 2x: never read as a keyboard, and never scrolled back', () => {
    expect(keyboardLayout({ height: 329.5, offsetTop: 200, scale: 2 }, 659, 0, true)).toEqual({ height: null, resetScroll: false });
    expect(keyboardLayout({ height: 200, offsetTop: 120, scale: 2 }, 659, 40, true)).toEqual({ height: null, resetScroll: false });
  });

  test('nothing on a desktop window, or with nothing covering the bottom', () => {
    expect(keyboardLayout({ height: 400, offsetTop: 0, scale: 1 }, 659, 0, false)).toEqual({ height: null, resetScroll: false });
    expect(keyboardLayout({ height: 640, offsetTop: 0, scale: 1 }, 659, 0, true)).toEqual({ height: null, resetScroll: false });
  });

  test('a phone window too short for the sheet folds though nothing covers it; one with room does not', () => {
    expect(keyboardLayout({ height: 200, offsetTop: 0, scale: 1 }, 200, 0, true)).toEqual({ height: 200, resetScroll: false });
    expect(keyboardLayout({ height: 300, offsetTop: 0, scale: 1 }, 300, 0, true)).toEqual({ height: null, resetScroll: false });
    expect(keyboardLayout({ height: 200, offsetTop: 0, scale: 1 }, 200, 0, false)).toEqual({ height: null, resetScroll: false });
  });

  test('a strip too small to fold for: New message ends above it; a pinch and a desktop window change nothing', () => {
    expect(stripHeight({ height: 581.6, scale: 1 }, 660, true)).toBe(582);
    expect(stripHeight({ height: 660, scale: 1 }, 660, true)).toBeNull();
    expect(stripHeight({ height: 330, scale: 2 }, 660, true)).toBeNull();
    expect(stripHeight({ height: 582, scale: 1 }, 660, false)).toBeNull();
  });

  test('what the keyboard covers, for a sheet that pads its own bottom: the layout height less what shows; nothing for a pinch or a desktop window', () => {
    expect(keyboardInset({ height: 257, scale: 1 }, 660, true)).toBe(403);
    expect(keyboardInset({ height: 581.6, scale: 1 }, 660, true)).toBe(78);
    expect(keyboardInset({ height: 660, scale: 1 }, 660, true)).toBe(0);
    expect(keyboardInset({ height: 330, scale: 2 }, 660, true)).toBe(0);
    expect(keyboardInset({ height: 257, scale: 1 }, 660, false)).toBe(0);
  });
});

test("inbox.css spells PHONE_QUERY in its phone block, and no other phone break", () => {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  expect(css).toContain(`@media ${PHONE_QUERY} {`);
  expect(css).not.toMatch(/@media \(max-width: 767px\) \{/);
});

test("the standalone Shape page's sheet spells PHONE_QUERY too", () => {
  const css = readFileSync(join(import.meta.dir, 'shape', 'standalone', 'shape-page.css'), 'utf8');
  expect(css).toContain(`@media ${PHONE_QUERY} {`);
  expect(css).not.toMatch(/@media \(max-width: 767px\) \{/);
});

type Listener = (event?: unknown) => void;
function events() {
  const map = new Map<string, Set<Listener>>();
  return {
    addEventListener: (type: string, fn: Listener) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      map.get(type)?.delete(fn);
    },
    fire: (type: string) => {
      for (const fn of [...(map.get(type) ?? [])]) fn({ type });
    },
    has: (type: string) => (map.get(type)?.size ?? 0) > 0,
  };
}

function fakeWindow(userAgent: string) {
  const vv = { height: 660, offsetTop: 0, scale: 1, ...events() };
  const scrolls: [number, number][] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const win = {
    visualViewport: vv,
    innerHeight: 660,
    scrollY: 0,
    scrollTo: (x: number, y: number) => {
      scrolls.push([x, y]);
      win.scrollY = y;
      vv.offsetTop = y;
    },
    setTimeout: (fn: () => void) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    ...events(),
  };
  const style = new Map<string, string>();
  const root = {
    clientHeight: 660,
    dataset: {} as Record<string, string>,
    style: { setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k) },
  };
  const doc = { documentElement: root, visibilityState: 'visible', ...events() };
  let frames: (() => void)[] = [];
  const globals = {
    window: win,
    document: doc,
    navigator: { userAgent, platform: userAgent.includes('iPhone') ? 'iPhone' : 'Linux armv8l', maxTouchPoints: 5 },
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: () => {},
  };
  const keyboardUp = () => {
    vv.height = 257;
    win.innerHeight = 257;
    win.scrollY = 403;
    vv.offsetTop = 403;
  };
  const keyboardDown = () => {
    vv.height = 660;
    win.innerHeight = 660;
  };
  const flush = () => {
    const run = frames;
    frames = [];
    for (const fn of run) fn();
  };
  const later = () => {
    const run = [...timers.values()];
    timers.clear();
    for (const fn of run) fn();
    flush();
  };
  return { vv, win, root, doc, style, scrolls, timers, globals, keyboardUp, keyboardDown, flush, later };
}

function withFakeWindow(userAgent: string, run: (w: ReturnType<typeof fakeWindow>) => void): void {
  const keys = ['window', 'document', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const saved = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
  const w = fakeWindow(userAgent);
  try {
    for (const k of keys) Object.defineProperty(globalThis, k, { value: w.globals[k], configurable: true, writable: true });
    run(w);
  } finally {
    keys.forEach((k, i) => {
      const d = saved[i];
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    });
  }
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

describe('trackKeyboard', () => {
  test('iOS 26: the keyboard is read though innerHeight shrank with it, the page is pinned and its pan undone', () => {
    withFakeWindow(IPHONE, (w) => {
      const stop = trackKeyboard();
      w.keyboardUp();
      w.vv.fire('resize');
      w.flush();
      expect(w.style.get('--ib-vvh')).toBe('257px');
      expect(w.style.get('--ib-kbd-inset')).toBe('403px');
      expect(w.root.dataset.ibKeyboard).toBe('');
      expect(w.root.dataset.ibKeyboardPin).toBe('tight');
      expect(w.scrolls.at(-1)).toEqual([0, 0]);
      expect(w.doc.has('touchmove')).toBe(true);

      w.win.scrollY = 120;
      w.scrolls.length = 0;
      w.win.fire('scroll');
      w.flush();
      expect(w.scrolls).toEqual([[0, 0]]);

      w.keyboardDown();
      w.doc.fire('visibilitychange');
      w.flush();
      expect(w.style.has('--ib-vvh')).toBe(false);
      expect(w.style.has('--ib-kbd-inset')).toBe(false);
      expect(w.root.dataset.ibKeyboardPin).toBeUndefined();
      expect(w.doc.has('touchmove')).toBe(false);
      stop();
    });
  });

  test('Android: the window still follows the keyboard, but nothing is pinned and no drag is guarded', () => {
    withFakeWindow(PIXEL, (w) => {
      const stop = trackKeyboard();
      w.keyboardUp();
      w.vv.fire('resize');
      w.flush();
      expect(w.style.get('--ib-vvh')).toBe('257px');
      expect(w.root.dataset.ibKeyboard).toBe('');
      expect(w.root.dataset.ibKeyboardPin).toBeUndefined();
      expect(w.doc.has('touchmove')).toBe(false);
      stop();
    });
  });

  test('a rotation with the keyboard up is read again, and the cleanup unpins', () => {
    withFakeWindow(IPHONE, (w) => {
      const stop = trackKeyboard();
      w.keyboardUp();
      w.vv.fire('resize');
      w.flush();
      w.root.clientHeight = 390;
      w.vv.height = 140;
      w.win.fire('orientationchange');
      w.flush();
      expect(w.style.get('--ib-vvh')).toBe('140px');
      expect(w.root.dataset.ibKeyboardPin).toBe('tight');
      stop();
      expect(w.root.dataset.ibKeyboardPin).toBeUndefined();
      expect(w.doc.has('touchmove')).toBe(false);
    });
  });

  test('a rotation whose layout height WebKit reports late: the pin read from the stale height clears on the re-read', () => {
    withFakeWindow(IPHONE, (w) => {
      const stop = trackKeyboard();
      w.vv.height = 390;
      w.win.fire('orientationchange');
      w.flush();
      expect(w.root.dataset.ibKeyboardPin).toBe('tight');
      w.root.clientHeight = 390;
      w.later();
      expect(w.root.dataset.ibKeyboardPin).toBeUndefined();
      expect(w.root.dataset.ibKeyboard).toBeUndefined();
      expect(w.style.has('--ib-vvh')).toBe(false);
      expect(w.doc.has('touchmove')).toBe(false);
      stop();
    });
  });

  test('a stale pin also clears when a field takes or loses focus; a real keyboard stays pinned on the re-read', () => {
    withFakeWindow(IPHONE, (w) => {
      const stop = trackKeyboard();
      w.vv.height = 390;
      w.win.fire('orientationchange');
      w.flush();
      w.root.clientHeight = 390;
      w.timers.clear();
      w.doc.fire('focusin');
      w.flush();
      expect(w.root.dataset.ibKeyboardPin).toBeUndefined();

      w.root.clientHeight = 660;
      w.win.fire('orientationchange');
      w.flush();
      expect(w.root.dataset.ibKeyboardPin).toBe('tight');
      w.root.clientHeight = 390;
      w.timers.clear();
      w.doc.fire('focusout');
      w.flush();
      expect(w.root.dataset.ibKeyboardPin).toBeUndefined();

      w.root.clientHeight = 660;
      w.keyboardUp();
      w.vv.fire('resize');
      w.flush();
      expect(w.root.dataset.ibKeyboardPin).toBe('tight');
      w.later();
      expect(w.root.dataset.ibKeyboardPin).toBe('tight');
      expect(w.style.get('--ib-vvh')).toBe('257px');

      w.vv.fire('resize');
      w.flush();
      w.vv.fire('resize');
      w.flush();
      expect(w.timers.size).toBe(1);
      stop();
      expect(w.timers.size).toBe(0);
      w.later();
      expect(w.root.dataset.ibKeyboardPin).toBeUndefined();
      expect(w.doc.has('focusin')).toBe(false);
      expect(w.doc.has('focusout')).toBe(false);
    });
  });
});

test('iOS WebKit is an iPhone, iPad or iPod, or iPadOS naming itself a Mac with touch; never Android or a Mac', () => {
  expect(isIOSWebKit({ userAgent: IPHONE })).toBe(true);
  expect(isIOSWebKit({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
  expect(isIOSWebKit({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  expect(isIOSWebKit({ userAgent: PIXEL, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false);
});
