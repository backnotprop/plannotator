/**
 * The silence watch (liveStream.ts) on fake timers: a stream that keeps
 * beating is never acted on; a silent one reconnects and catches up once per
 * window, says it is dead only when the reconnect brings nothing within the
 * grace, and is live again at its next frame; a tab shown after a long hide,
 * or back online while dead, catches up.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { DEAD_NOTE_DELAY_MS, STREAM_STALE_MS, watchLiveStream } from './liveStream';

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

const HEARTBEAT_MS = 10_000;

function setup(options: { visible?: boolean } = {}) {
  const log: string[] = [];
  const doc = new EventTarget();
  const win = new EventTarget();
  const state = { visible: options.visible ?? true };
  const watch = watchLiveStream(
    {
      reconnect: () => log.push('reconnect'),
      catchUp: () => log.push('catch-up'),
      onLive: (live) => log.push(live ? 'live' : 'dead'),
    },
    { isVisible: () => state.visible, lifecycle: { document: doc, window: win } },
  );
  const show = (visible: boolean) => {
    state.visible = visible;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  return { log, watch, show, online: () => win.dispatchEvent(new Event('online')) };
}

/** Advance the clock, hearing a heartbeat every HEARTBEAT_MS when `beating`. */
function run(ms: number, watch: { heard: () => void }, beating: boolean): void {
  for (let t = HEARTBEAT_MS; t <= ms; t += HEARTBEAT_MS) {
    jest.advanceTimersByTime(HEARTBEAT_MS);
    if (beating) watch.heard();
  }
  jest.advanceTimersByTime(ms % HEARTBEAT_MS);
}

test('a stream that keeps beating is never acted on: ten minutes, no reconnect, no catch-up, no note', () => {
  const { log, watch } = setup();
  run(10 * 60_000, watch, true);
  expect(log).toEqual([]);
  watch.stop();
});

test('one late heartbeat is not a death (the window is two and a half beats)', () => {
  const { log, watch } = setup();
  run(30_000, watch, true);
  // The next beat 22 s after the last (12 s late): still inside the window.
  jest.advanceTimersByTime(22_000);
  watch.heard();
  run(60_000, watch, true);
  expect(log).toEqual([]);
  watch.stop();
});

test('silent past the window: reconnect and catch up once; a reconnect that answers at once shows no note', () => {
  const { log, watch } = setup();
  watch.heard();
  jest.advanceTimersByTime(STREAM_STALE_MS - 1);
  expect(log).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(log).toEqual(['reconnect', 'catch-up']);
  // The new stream's hello, well inside the grace.
  jest.advanceTimersByTime(80);
  watch.heard();
  jest.advanceTimersByTime(DEAD_NOTE_DELAY_MS * 2);
  expect(log).toEqual(['reconnect', 'catch-up']);
  run(5 * 60_000, watch, true);
  expect(log).toEqual(['reconnect', 'catch-up']);
  watch.stop();
});

test('a reconnect that brings nothing: dead once after the grace, a reconnect and catch-up per window, live at the next frame', () => {
  const { log, watch } = setup();
  jest.advanceTimersByTime(STREAM_STALE_MS);
  expect(log).toEqual(['reconnect', 'catch-up']);
  jest.advanceTimersByTime(DEAD_NOTE_DELAY_MS - 1);
  expect(log).not.toContain('dead');
  jest.advanceTimersByTime(1);
  expect(log).toEqual(['reconnect', 'catch-up', 'dead']);
  // Still silent: one attempt per window, never another "dead".
  jest.advanceTimersByTime(STREAM_STALE_MS * 4);
  expect(log.filter((e) => e === 'dead')).toHaveLength(1);
  expect(log.filter((e) => e === 'reconnect')).toHaveLength(5);
  expect(log.filter((e) => e === 'catch-up')).toHaveLength(5);
  watch.heard();
  expect(log.at(-1)).toBe('live');
  run(5 * 60_000, watch, true);
  expect(log.filter((e) => e === 'live')).toHaveLength(1);
  expect(log.filter((e) => e === 'reconnect')).toHaveLength(5);
  watch.stop();
});

test('shown again after a hide longer than the window: one catch-up; a short hide: none', () => {
  const { log, watch, show } = setup();
  show(false);
  run(STREAM_STALE_MS + 10_000, watch, true);
  show(true);
  expect(log).toEqual(['catch-up']);
  show(false);
  run(10_000, watch, true);
  show(true);
  expect(log).toEqual(['catch-up']);
  watch.stop();
});

test('shown again with the stream silent past the window: reconnect and catch up at once', () => {
  const { log, watch, show } = setup({ visible: false });
  watch.heard();
  // A hidden tab's timers held back: the check has not fired yet when it is shown.
  jest.setSystemTime(Date.now() + STREAM_STALE_MS + 5_000);
  show(true);
  expect(log).toEqual(['reconnect', 'catch-up']);
  watch.stop();
});

test('back online while dead: reconnect and catch up at once; online while healthy and in front: nothing', () => {
  const { log, watch, online } = setup();
  run(30_000, watch, true);
  online();
  expect(log).toEqual([]);
  jest.advanceTimersByTime(STREAM_STALE_MS + DEAD_NOTE_DELAY_MS);
  expect(log).toEqual(['reconnect', 'catch-up', 'dead']);
  jest.advanceTimersByTime(5_000);
  online();
  expect(log).toEqual(['reconnect', 'catch-up', 'dead', 'reconnect', 'catch-up']);
  watch.stop();
});

test('restart counts the silence from now (a tab that woke up or started following)', () => {
  const { log, watch } = setup();
  jest.advanceTimersByTime(STREAM_STALE_MS - 1_000);
  watch.restart();
  jest.advanceTimersByTime(STREAM_STALE_MS - 1);
  expect(log).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(log).toEqual(['reconnect', 'catch-up']);
  watch.stop();
});

test('stopped: nothing more, and its listeners are gone', () => {
  const { log, watch, show, online } = setup();
  watch.stop();
  jest.advanceTimersByTime(STREAM_STALE_MS * 3);
  show(false);
  show(true);
  online();
  expect(log).toEqual([]);
});
