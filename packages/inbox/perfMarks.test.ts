/**
 * The window's performance marks (perfMarks.ts) run only while the Inbox's debug log is on. Off, an interaction
 * leaves no `performance.measure`, asks for no frame, and the overlay never shows even when asked for. On, each
 * interaction leaves its `pn:` measure, the overlay shows when asked for, and the timings stay honest: a thread
 * left before it loaded lends no old start to a later open, a hidden window times nothing, and a burst waits on
 * one frame. Each interaction is dropped if the window was hidden at any moment since it started; a second read of
 * the thread being opened keeps its start, and a read that lands after the person left it ends it. When debug goes
 * off, the overlay, the observers and the visibility listener go too. The overlay's opt-in is an exact `perf=1` / `perf=0` in the hash, never a substring an agent's file
 * name could carry. The debug state is the one seam (debugLog.ts `debugLogOn`), replaced here so no recorder starts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
let debugOn = false;
const stops = new Set<() => void>();
if (hasDom) {
  mock.module(resolve(import.meta.dir, './debugLog.ts'), () => ({
    debugLogOn: () => debugOn,
    debugNote: () => {},
    whenDebugLogStops: (listener: () => void) => {
      stops.add(listener);
      return () => void stops.delete(listener);
    },
  }));
}
/** The window hears that debug went off (debugLog.ts learnDebugLog). */
const debugGoesOff = () => {
  debugOn = false;
  for (const listener of [...stops]) {
    stops.delete(listener);
    listener();
  }
};
const marks = (hasDom ? await import('./perfMarks') : {}) as typeof import('./perfMarks');

const OVERLAY_KEY = 'plannotator-inbox-perf';
const measured: { name: string; start: number; end: number; detail?: unknown }[] = [];
let frames = 0;
let visibility: DocumentVisibilityState = 'visible';
let restore: (() => void) | null = null;

beforeAll(() => {
  if (!hasDom) return;
  const measure = performance.measure.bind(performance);
  const raf = window.requestAnimationFrame.bind(window);
  performance.measure = ((name: string, options?: PerformanceMeasureOptions) => {
    measured.push({ name, start: Number(options?.start), end: Number(options?.end), detail: options?.detail });
    return measure(name, options);
  }) as typeof performance.measure;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    frames++;
    return raf(cb);
  };
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  const hash = window.location.hash;
  window.localStorage.setItem(OVERLAY_KEY, '1');
  restore = () => {
    performance.measure = measure as typeof performance.measure;
    window.requestAnimationFrame = raf;
    delete (document as { visibilityState?: unknown }).visibilityState;
    window.localStorage.removeItem(OVERLAY_KEY);
    window.location.hash = hash;
    document.querySelector('[data-perf-overlay]')?.remove();
  };
});
afterAll(() => restore?.());
afterEach(() => {
  visibility = 'visible';
});

const drawn = async () => {
  for (let i = 0; i < 4; i++) await new Promise((done) => setTimeout(done, 30));
};
const named = (name: string) => measured.filter((m) => m.name === name);
const hide = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};

test.skipIf(!hasDom)('debug off: no measure, no frame asked for, no overlay', async () => {
  debugOn = false;
  expect(marks.perfOn()).toBe(false);
  marks.perfFirstList([{ threads: [1, 2] }]);
  marks.perfInteraction('theme');
  marks.perfInteraction('expand-all', 40);
  marks.perfKeystroke();
  marks.perfThreadOpenStart('msg_a');
  marks.perfThreadReadLanded('msg_a', 12, true);
  marks.perfUntilNextFrame('record-refresh', marks.perfStart());
  expect(marks.perfStart()).toBeNull();
  await drawn();
  expect(measured).toEqual([]);
  expect(frames).toBe(0);
  expect(document.querySelector('[data-perf-overlay]')).toBeNull();
});

test.skipIf(!hasDom)('debug on: each interaction leaves its pn: measure, and the asked-for overlay shows', async () => {
  debugOn = true;
  expect(marks.perfOn()).toBe(true);
  marks.perfInteraction('expand-all', 40);
  marks.perfThreadOpenStart('msg_b');
  marks.perfThreadReadLanded('msg_b', 12, true);
  marks.perfUntilNextFrame('record-refresh', marks.perfStart());
  await drawn();
  expect(named('pn:expand-all').map((m) => m.detail)).toEqual([{ messages: 40 }]);
  expect(named('pn:thread-open').map((m) => m.detail)).toEqual([{ messages: 12 }]);
  expect(named('pn:record-refresh')).toHaveLength(1);
  expect(frames).toBeGreaterThan(0);
  expect(document.querySelector('[data-perf-overlay]')).not.toBeNull();
});

test.skipIf(!hasDom)('a thread left before its read came back lends no start to a later open', async () => {
  debugOn = true;
  measured.length = 0;
  // A, then B before A's read is back: A's late answer draws nothing.
  marks.perfThreadOpenStart('msg_a');
  marks.perfThreadOpenStart('msg_b');
  marks.perfThreadReadLanded('msg_a', null, false);
  await drawn();
  expect(named('pn:thread-open')).toEqual([]);
  // A again, much later (the list in between): timed from this open, not the first.
  await new Promise((done) => setTimeout(done, 80));
  const reopened = performance.now();
  marks.perfThreadOpenStart('msg_a');
  marks.perfThreadReadLanded('msg_a', 3, true);
  await drawn();
  const open = named('pn:thread-open');
  expect(open).toHaveLength(1);
  expect(open[0]!.start).toBeGreaterThanOrEqual(reopened);
});

test.skipIf(!hasDom)('a hidden window times nothing, and a wait the window was hidden during is dropped', async () => {
  debugOn = true;
  measured.length = 0;
  const before = frames;
  visibility = 'hidden';
  marks.perfUntilNextFrame('record-refresh', marks.perfStart());
  marks.perfKeystroke();
  expect(marks.perfStart()).toBeNull();
  await drawn();
  expect(frames).toBe(before);
  // Asked while shown, hidden before the frame, shown again: the measure would hold the hidden time.
  visibility = 'visible';
  marks.perfUntilNextFrame('record-refresh', marks.perfStart());
  hide('hidden');
  hide('visible');
  await drawn();
  expect(measured).toEqual([]);
  // The next one, all visible, is timed again.
  marks.perfUntilNextFrame('record-refresh', marks.perfStart());
  await drawn();
  expect(named('pn:record-refresh')).toHaveLength(1);
});

test.skipIf(!hasDom)('a burst waits on one frame, timed from its first', async () => {
  debugOn = true;
  measured.length = 0;
  const first = performance.now();
  marks.perfUntilNextFrame('record-refresh', marks.perfStart(first));
  marks.perfUntilNextFrame('record-refresh', marks.perfStart(first + 5));
  marks.perfUntilNextFrame('record-refresh', marks.perfStart(first + 10));
  await drawn();
  expect(named('pn:record-refresh').map((m) => m.start)).toEqual([first]);
});

test.skipIf(!hasDom)('a hide after the interaction started, before its frame was asked for, drops it', async () => {
  debugOn = true;
  measured.length = 0;
  // A thread tapped, the person switches away and back before its read lands.
  marks.perfThreadOpenStart('msg_h');
  hide('hidden');
  hide('visible');
  marks.perfThreadReadLanded('msg_h', 5, true);
  // An event heard, the window hidden and shown before the re-read is drawn.
  const heard = marks.perfStart();
  hide('hidden');
  hide('visible');
  marks.perfUntilNextFrame('record-refresh', heard);
  await drawn();
  expect(measured).toEqual([]);
});

test.skipIf(!hasDom)('a second read of the thread being opened keeps its start; a read landing after it was left ends it', async () => {
  debugOn = true;
  measured.length = 0;
  const first = performance.now();
  marks.perfThreadOpenStart('msg_s');
  await new Promise((done) => setTimeout(done, 60));
  // An event's re-read (or a retry) of the same thread, then a read that was not applied while it is still shown.
  marks.perfThreadOpenStart('msg_s');
  marks.perfThreadReadLanded('msg_s', null, true);
  marks.perfThreadReadLanded('msg_s', 4, true);
  await drawn();
  expect(named('pn:thread-open')).toHaveLength(1);
  expect(named('pn:thread-open')[0]!.start).toBeLessThan(first + 30);
  // Opened, left for the list, its read lands unapplied: a later open of it is timed from then.
  measured.length = 0;
  marks.perfThreadOpenStart('msg_s');
  marks.perfThreadReadLanded('msg_s', null, false);
  await new Promise((done) => setTimeout(done, 60));
  const reopened = performance.now();
  marks.perfThreadOpenStart('msg_s');
  marks.perfThreadReadLanded('msg_s', 4, true);
  await drawn();
  expect(named('pn:thread-open').map((m) => m.start >= reopened)).toEqual([true]);
});

test.skipIf(!hasDom)('debug going off removes the overlay and the listeners, and drops what was in flight', async () => {
  debugOn = true;
  expect(marks.perfOn()).toBe(true);
  expect(document.querySelectorAll('[data-perf-overlay]')).toHaveLength(1);
  const removed: string[] = [];
  const remove = document.removeEventListener.bind(document);
  document.removeEventListener = ((...args: Parameters<typeof remove>) => {
    removed.push(args[0]);
    return remove(...args);
  }) as typeof document.removeEventListener;
  try {
    measured.length = 0;
    marks.perfUntilNextFrame('record-refresh', marks.perfStart());
    debugGoesOff();
  } finally {
    document.removeEventListener = remove;
  }
  await drawn();
  expect(measured).toEqual([]);
  expect(document.querySelector('[data-perf-overlay]')).toBeNull();
  expect(removed).toContain('visibilitychange');
  // On again: one overlay, not two, and timings flow.
  debugOn = true;
  marks.perfUntilNextFrame('record-refresh', marks.perfStart());
  await drawn();
  expect(document.querySelectorAll('[data-perf-overlay]')).toHaveLength(1);
  expect(named('pn:record-refresh')).toHaveLength(1);
});

test.skipIf(!hasDom)('the overlay opt-in is the exact perf=1 / perf=0 token, never a substring', () => {
  window.localStorage.removeItem(OVERLAY_KEY);
  window.location.hash = '#thread=msg_01J9Z3V5K8Q2W4E6R7T8Y9M0NP&file=att_1&linked=docs%2Fperf-report.html';
  expect(marks.overlayOn()).toBe(false);
  window.location.hash = '#set=msg_01J9Z3V5K8Q2W4E6R7T8Y9M0NP:perf-choice';
  expect(marks.overlayOn()).toBe(false);
  window.location.hash = '#perf';
  expect(marks.overlayOn()).toBe(false);
  expect(window.localStorage.getItem(OVERLAY_KEY)).toBeNull();
  window.location.hash = '#thread=msg_01J9Z3V5K8Q2W4E6R7T8Y9M0NP&perf=1';
  expect(marks.overlayOn()).toBe(true);
  window.location.hash = '#thread=msg_01J9Z3V5K8Q2W4E6R7T8Y9M0NP';
  expect(marks.overlayOn()).toBe(true);
  window.location.hash = '#perf=0';
  expect(marks.overlayOn()).toBe(false);
  expect(window.localStorage.getItem(OVERLAY_KEY)).toBeNull();
});
