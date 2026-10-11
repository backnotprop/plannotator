/**
 * The surface's channel to its shell (adr/implementation/inbox-mobile.md,
 * sections 5 and 10): `window.webkit` first, as the iPhone's WKWebView
 * injects it; else the Android shell's `window.plannotatorShell`, which takes
 * strings; with neither (a desktop browser opening the file), nothing.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { listenToShell, postToShell } from './bridge';

// The bridge needs only a global `window`. The default run has no DOM
// (happy-dom is opt-in with DOM_TESTS=1), so globalThis stands in for it here.
const borrowed = typeof window === 'undefined';
if (borrowed) (globalThis as { window?: unknown }).window = globalThis;
afterAll(() => {
  if (borrowed) delete (globalThis as { window?: unknown }).window;
});

type Channels = { webkit?: unknown; plannotatorShell?: unknown };
const win = window as unknown as Channels;

function webkitChannel(): unknown[] {
  const got: unknown[] = [];
  win.webkit = { messageHandlers: { plannotatorSurface: { postMessage: (m: unknown) => got.push(m) } } };
  return got;
}

function androidChannel(): unknown[] {
  const got: unknown[] = [];
  win.plannotatorShell = { postMessage: (m: unknown) => got.push(m) };
  return got;
}

afterEach(() => {
  delete win.webkit;
  delete win.plannotatorShell;
});

describe('postToShell', () => {
  test('iOS: the message object goes to the WebKit handler with its version', () => {
    const got = webkitChannel();
    postToShell({ type: 'ready', bridge: 1, build: 'test' });
    expect(got).toEqual([{ v: 1, type: 'ready', bridge: 1, build: 'test' }]);
  });

  test('Android: with no window.webkit, the message goes to plannotatorShell as a JSON string', () => {
    const got = androidChannel();
    postToShell({ type: 'selection', quote: 'retries on 409', draft: null });
    expect(got).toHaveLength(1);
    expect(typeof got[0]).toBe('string');
    expect(JSON.parse(got[0] as string)).toEqual({ v: 1, type: 'selection', quote: 'retries on 409', draft: null });
  });

  test('both present: window.webkit wins and the Android channel hears nothing', () => {
    const ios = webkitChannel();
    const android = androidChannel();
    postToShell({ type: 'link', href: 'https://docs.stripe.com/' });
    expect(ios).toEqual([{ v: 1, type: 'link', href: 'https://docs.stripe.com/' }]);
    expect(android).toEqual([]);
  });

  test('window.webkit without the surface handler still takes the first path: nothing reaches plannotatorShell', () => {
    win.webkit = { messageHandlers: {} };
    const android = androidChannel();
    expect(() => postToShell({ type: 'ready', bridge: 1, build: 'test' })).not.toThrow();
    expect(android).toEqual([]);
  });

  test('neither present: nothing is posted and nothing throws', () => {
    expect(() => postToShell({ type: 'ready', bridge: 1, build: 'test' })).not.toThrow();
  });
});

describe('listenToShell on Android', () => {
  test('a message in another bridge version is answered with error over plannotatorShell', () => {
    const got = androidChannel();
    const seen: unknown[] = [];
    const stop = listenToShell((m) => seen.push(m));
    try {
      (window as unknown as { plannotatorSurface: { receive: (m: unknown) => void } }).plannotatorSurface.receive({ v: 2, type: 'set_mode', mode: 'interact' });
    } finally {
      stop();
    }
    expect(seen).toEqual([]);
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0] as string)).toMatchObject({ v: 1, type: 'error', code: 'bridge_version' });
  });
});
