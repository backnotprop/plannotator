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

/**
 * Timers the page's own, except while `asleep`: a callback that comes due then waits for `wake` (the computer
 * slept, or the browser held a hidden tab's timers back), while the clock runs on.
 */
function sleepyTimers() {
  let asleep = false;
  let waiting: (() => void)[] = [];
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const timer = { cancelled: false, id: null as ReturnType<typeof setTimeout> | null };
        const run = () => {
          if (!timer.cancelled) fn();
        };
        timer.id = setTimeout(() => {
          if (asleep) waiting.push(run);
          else run();
        }, ms);
        return timer;
      },
      clearTimeout: (handle: unknown) => {
        const timer = handle as { cancelled: boolean; id: ReturnType<typeof setTimeout> | null };
        timer.cancelled = true;
        if (timer.id !== null) clearTimeout(timer.id);
      },
    },
    sleep: () => {
      asleep = true;
    },
    wake: () => {
      asleep = false;
      const due = waiting;
      waiting = [];
      for (const fn of due) fn();
    },
  };
}

function setup(options: { visible?: boolean; timers?: ReturnType<typeof sleepyTimers>['timers'] } = {}) {
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
    { isVisible: () => state.visible, lifecycle: { document: doc, window: win }, timers: options.timers },
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

test('a healthy tab shown again, after a hide far longer than the window, reads nothing', () => {
  const { log, watch, show } = setup();
  show(false);
  run(60_000, watch, true);
  show(true);
  show(false);
  run(10 * 60_000, watch, true);
  show(true);
  expect(log).toEqual([]);
  watch.stop();
});

test('shown again with the stream silent past the window (its timers were held back): a short grace, then reconnect and catch up', () => {
  const clock = sleepyTimers();
  const { log, watch, show } = setup({ visible: false, timers: clock.timers });
  watch.heard();
  // A hidden tab's timers held back: the check has not run yet when it is shown.
  clock.sleep();
  jest.advanceTimersByTime(STREAM_STALE_MS + 5_000);
  show(true);
  // Shown, the tab's timers run again: the held check was replaced by the grace.
  clock.wake();
  expect(log).toEqual([]);
  jest.advanceTimersByTime(DEAD_NOTE_DELAY_MS);
  expect(log).toEqual(['reconnect', 'catch-up']);
  watch.stop();
});

test('shown while the stream is dead: a catch-up at once', () => {
  const { log, watch, show } = setup();
  jest.advanceTimersByTime(STREAM_STALE_MS + DEAD_NOTE_DELAY_MS);
  expect(log).toEqual(['reconnect', 'catch-up', 'dead']);
  show(false);
  jest.advanceTimersByTime(5_000);
  show(true);
  expect(log).toEqual(['reconnect', 'catch-up', 'dead', 'catch-up']);
  watch.stop();
});

test('a check that runs long past its time (the computer slept) waits a grace: the first frame after the wake cancels it', () => {
  const clock = sleepyTimers();
  const { log, watch } = setup({ timers: clock.timers });
  run(30_000, watch, true);
  // Asleep for ten minutes: the overdue check runs the moment the computer wakes, before any frame.
  clock.sleep();
  jest.advanceTimersByTime(10 * 60_000);
  clock.wake();
  expect(log).toEqual([]);
  // The leader's next frame comes in the grace.
  jest.advanceTimersByTime(800);
  watch.heard();
  jest.advanceTimersByTime(DEAD_NOTE_DELAY_MS * 3);
  expect(log).toEqual([]);
  run(2 * 60_000, watch, true);
  expect(log).toEqual([]);
  watch.stop();
});

test('a late check with nothing heard in its grace acts when the grace ends', () => {
  const clock = sleepyTimers();
  const { log, watch } = setup({ timers: clock.timers });
  run(30_000, watch, true);
  clock.sleep();
  jest.advanceTimersByTime(10 * 60_000);
  clock.wake();
  expect(log).toEqual([]);
  jest.advanceTimersByTime(DEAD_NOTE_DELAY_MS);
  expect(log).toEqual(['reconnect', 'catch-up']);
  watch.stop();
});

test('back online while dead: reconnect and catch up at once; online while healthy: nothing', () => {
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
