/**
 * The phone's keyboard rule (phone.ts keyboardLayout) and the one phone
 * query. The failures these catch: a pinch-zoom read as a keyboard (the
 * window shrinks to the zoomed viewport and jumps back to the corner on every
 * pan), and inbox.css's phone block drifting from PHONE_QUERY.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHONE_QUERY, isIOSWebKit, keyboardLayout, stripHeight, trackKeyboard } from './phone';

describe('the keyboard on a phone', () => {
  test('the keyboard up, unzoomed: the window takes the height above it and undoes the pan', () => {
    expect(keyboardLayout({ height: 400, offsetTop: 120, scale: 1 }, 659, 0, true)).toEqual({ height: 400, resetScroll: true });
    expect(keyboardLayout({ height: 400.4, offsetTop: 0, scale: 1 }, 659, 0, true)).toEqual({ height: 400, resetScroll: false });
  });

  test('pinch-zoomed to 2x: never read as a keyboard, and never scrolled back', () => {
    // At scale 2 the visual viewport is half the window, panned anywhere.
    expect(keyboardLayout({ height: 329.5, offsetTop: 200, scale: 2 }, 659, 0, true)).toEqual({ height: null, resetScroll: false });
    // Zoomed with the keyboard up too: left alone until the zoom is undone.
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
});

test("inbox.css spells PHONE_QUERY in its phone block, and no other phone break", () => {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  expect(css).toContain(`@media ${PHONE_QUERY} {`);
  // A phone rule elsewhere must use the same query, not a width of its own.
  expect(css).not.toMatch(/@media \(max-width: 767px\) \{/);
});

/**
 * trackKeyboard against a fake window, as the owner's iPhone (iOS 26) read it with the keyboard up: clientHeight 660,
 * innerHeight and the visual viewport 257, the page panned by Safari. The failures these catch: the keyboard read
 * against innerHeight (seen as none, so the page pans freely), a pan left in place, the pin and its drag guard put on
 * Android, and a pin that outlives the keyboard. A headless browser cannot pan its page, so this is where the reset
 * is proved. Every global is replaced inside the test and restored after it.
 */
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
  const win = {
    visualViewport: vv,
    innerHeight: 660,
    scrollY: 0,
    scrollTo: (x: number, y: number) => {
      scrolls.push([x, y]);
      win.scrollY = y;
      vv.offsetTop = y;
    },
    // A phone in portrait: PHONE_QUERY matches.
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
  /** Safari with the keyboard up and the page panned to the field (probe readings 10 to 32). */
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
  return { vv, win, root, doc, style, scrolls, globals, keyboardUp, keyboardDown, flush };
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
      expect(w.root.dataset.ibKeyboard).toBe('');
      expect(w.root.dataset.ibKeyboardPin).toBe('tight');
      expect(w.scrolls.at(-1)).toEqual([0, 0]);
      expect(w.doc.has('touchmove')).toBe(true);

      // A later pan, reported only as the window's scroll (iOS 26): undone on the next frame.
      w.win.scrollY = 120;
      w.scrolls.length = 0;
      w.win.fire('scroll');
      w.flush();
      expect(w.scrolls).toEqual([[0, 0]]);

      // The keyboard closes while the tab is away, with no visual viewport event: the return to the tab unpins.
      w.keyboardDown();
      w.doc.fire('visibilitychange');
      w.flush();
      expect(w.style.has('--ib-vvh')).toBe(false);
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
      // On its side: 390 tall, ~140 above the keyboard.
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
});

test('iOS WebKit is an iPhone, iPad or iPod, or iPadOS naming itself a Mac with touch; never Android or a Mac', () => {
  expect(isIOSWebKit({ userAgent: IPHONE })).toBe(true);
  expect(isIOSWebKit({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
  expect(isIOSWebKit({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  expect(isIOSWebKit({ userAgent: PIXEL, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false);
});
