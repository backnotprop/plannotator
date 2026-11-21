/**
 * The Inbox window's performance marks, only while the Inbox's debug log is on (`PLANNOTATOR_INBOX_DEBUG=1` or
 * `inboxDebug: true`; the window learns it from the answers, debugLog.ts). Then each key interaction leaves one
 * `performance.measure` named `pn:<what>` (Chrome DevTools → Performance shows them under Timings), from the
 * moment it starts to the next frame the browser draws after it, which is what the person waits for.
 *
 *   pn:first-list      page start → the first list drawn
 *   pn:thread-open     a thread's read starts → its messages drawn (detail: messages)
 *   pn:record-refresh  an event from the server → the list and the open thread read again and drawn
 *   pn:theme           the light/dark switch → the next frame (pn:theme-settled: → the main thread is free again)
 *   pn:expand-all      "Expand all messages" → drawn
 *   pn:keystroke       a key in the reply box → the next frame; only noted when ≥ 50 ms
 *
 * Debug off, every entry point returns after one boolean check: no clock read, no frame callback, no measure,
 * no observer.
 * - An interaction slower than SLOW_UI_MS is also written to the debug log (`slow_ui`), with the page's memory then
 *   (`heap`, `heap_limit`, `imgs`, `nodes`; debugLog.ts `debugMemory`).
 * - `localStorage['plannotator-inbox-perf'] = '1'` (or `#perf=1` once in the address; `#perf=0` turns it off) also shows a small overlay with
 *   the last timings and the long tasks, while debug is on. Nothing is sent anywhere else.
 *
 * Entries are cleared as they are made, so a window open for weeks keeps none: an observer hears each one first.
 */
import { debugLogOn, debugMemory, debugNote, whenDebugLogStops } from './debugLog';

export type PerfWhat = 'first-list' | 'thread-open' | 'record-refresh' | 'theme' | 'theme-settled' | 'expand-all' | 'keystroke';

/** An interaction at least this slow is written to the debug log (when it is on). */
export const SLOW_UI_MS = 100;
const KEYSTROKE_NOTE_MS = 50;
const OVERLAY_KEY = 'plannotator-inbox-perf';

const supported = typeof performance !== 'undefined' && typeof performance.measure === 'function' && typeof window !== 'undefined';
let listening = false;

/** The one check every entry point makes: debug on (and a browser that can measure). The first yes starts the listeners. */
export function perfOn(): boolean {
  if (!supported || !debugLogOn()) return false;
  if (!listening) startListening();
  return true;
}

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
/** Bumped each time the window is hidden: an interaction that started before then holds the hidden time too, so it is dropped. */
let hiddenTimes = 0;

/** When an interaction started, and how many hides the window had had then. Null: not timed (debug off, or hidden). */
export interface PerfStart {
  at: number;
  hides: number;
}
/** An interaction starts now: timed only while debug is on and the window is shown. */
export function perfStart(at?: number): PerfStart | null {
  if (!perfOn() || !visible()) return null;
  return { at: at ?? performance.now(), hides: hiddenTimes };
}

/** At most one frame waited on per interaction kind (a burst of events or keys is timed from its first). */
const pending = new Map<PerfWhat, object>();
/** One channel for every wait (a task after the frame's paint), its callbacks in order. */
let channel: MessageChannel | null = null;
const afterPaint: (() => void)[] = [];

/**
 * After the next frame is drawn: a rAF, then a task (the frame's paint happens between them). Nothing while the
 * window is hidden (a hidden window draws no frames), nothing when one is already waited on for `what`, and
 * nothing if the window was hidden at any moment since the interaction started.
 */
function afterNextFrame(what: PerfWhat, start: PerfStart, done: (now: number) => void): void {
  if (!visible() || start.hides !== hiddenTimes || pending.has(what)) return;
  const token = {};
  pending.set(what, token);
  requestAnimationFrame(() => {
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => afterPaint.shift()?.();
    }
    afterPaint.push(() => {
      if (pending.get(what) === token) pending.delete(what);
      if (start.hides === hiddenTimes && listening) done(performance.now());
    });
    channel.port2.postMessage(0);
  });
}

/** Leave a `pn:<what>` measure from `start` (a `performance.now()` time) to now. Called past the gate only. */
function perfMeasure(what: PerfWhat, start: number, detail?: Record<string, number>): void {
  try {
    const end = performance.now();
    performance.measure(`pn:${what}`, { start, end, detail });
    // Heard by the observer below, then dropped: the timeline never grows.
    performance.clearMeasures(`pn:${what}`);
  } catch {
    // Never in the way.
  }
}

/** From `start` (perfStart) to the next frame drawn. */
export function perfUntilNextFrame(what: PerfWhat, start: PerfStart | null, detail?: Record<string, number>): void {
  if (!start || !perfOn()) return;
  afterNextFrame(what, start, () => perfMeasure(what, start.at, detail));
}

/** An interaction that starts now: to the next frame, then (theme only) to the first idle moment after it. */
export function perfInteraction(what: 'theme' | 'expand-all', messages?: number): void {
  const start = perfStart();
  if (!start) return;
  const detail = messages === undefined ? undefined : { messages };
  afterNextFrame(what, start, () => {
    perfMeasure(what, start.at, detail);
    if (what === 'theme') {
      const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
      if (idle) idle(() => start.hides === hiddenTimes && perfMeasure('theme-settled', start.at), { timeout: 5000 });
    }
  });
}

/** A key in the reply box, timed from the key's event. Only a slow one leaves a measure. */
export function perfKeystroke(): void {
  if (!perfOn()) return;
  const start = perfStart((window.event as Event | undefined)?.timeStamp || performance.now());
  if (!start) return;
  afterNextFrame('keystroke', start, (now) => {
    if (now - start.at >= KEYSTROKE_NOTE_MS) perfMeasure('keystroke', start.at);
  });
}

/**
 * The thread being opened and when its read started. One thread opens at a time: another thread's open replaces
 * it; a second read of the same thread (a retry, an event's re-read) keeps the first start, so a slow open is
 * timed whole. A read that lands after the person left that thread ends it, so a later open starts afresh.
 */
let opening: { threadId: string; start: PerfStart } | null = null;
export function perfThreadOpenStart(threadId: string): void {
  if (opening?.threadId === threadId || !perfOn()) return;
  const start = perfStart();
  opening = start ? { threadId, start } : null;
}
/**
 * A thread read came back: `drawnMessages` when it was applied (its messages go on screen), else null; `shown`
 * whether that thread is still the one on screen. Not applied and not shown: the open was left.
 */
export function perfThreadReadLanded(threadId: string, drawnMessages: number | null, shown: boolean): void {
  if (opening?.threadId !== threadId) return;
  if (drawnMessages !== null) {
    const start = opening.start;
    opening = null;
    perfUntilNextFrame('thread-open', start, { messages: drawnMessages });
  } else if (!shown) opening = null;
}
export function perfThreadOpenDropped(threadId: string): void {
  if (opening?.threadId === threadId) opening = null;
}

let firstListDone = false;
/** The first list drawn after the page started (time 0 is the navigation's start). */
export function perfFirstList(sections: readonly { threads: readonly unknown[] }[]): void {
  if (firstListDone) return;
  firstListDone = true;
  const start = perfStart(0);
  if (start) perfUntilNextFrame('first-list', start, { rows: sections.reduce((n, section) => n + section.threads.length, 0) });
}

// ───────── listeners: the debug log and the overlay ─────────
interface Seen {
  what: string;
  ms: number;
  at: number;
  detail?: Record<string, number>;
}
const recent: Seen[] = [];
let longTasks = { count: 0, ms: 0, longest: 0 };
let overlay: HTMLElement | null = null;

/**
 * The overlay's own opt-in, on top of the debug log: an exact `perf=1` in the address's hash turns it on for this
 * browser, `perf=0` turns it off. Only that token: agents choose parts of the hash (a linked page's path, a question
 * key), and a `linked=perf-report.html` must not switch anything on.
 */
export function overlayOn(): boolean {
  try {
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('perf');
    if (token === '1') window.localStorage.setItem(OVERLAY_KEY, '1');
    else if (token === '0') window.localStorage.removeItem(OVERLAY_KEY);
    return window.localStorage.getItem(OVERLAY_KEY) === '1';
  } catch {
    return false;
  }
}

function draw(): void {
  if (!overlay) return;
  const rows = recent
    .slice(-12)
    .reverse()
    .map((s) => `${s.what.padEnd(15)} ${String(Math.round(s.ms)).padStart(6)} ms${s.detail ? `  ${Object.entries(s.detail).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`);
  overlay.textContent = [`long tasks ${longTasks.count}  ${Math.round(longTasks.ms)} ms  (longest ${Math.round(longTasks.longest)} ms)`, ...rows].join('\n');
}

/** What the listeners left attached, undone when the window hears that debug went off. */
const teardown: (() => void)[] = [];

/** Debug went off (debugLog.ts): every listener, observer and the overlay go, and nothing in flight is measured. */
function stopListening(): void {
  listening = false;
  for (const undo of teardown.splice(0)) {
    try {
      undo();
    } catch {
      // Never in the way.
    }
  }
  overlay = null;
  opening = null;
  pending.clear();
  hiddenTimes++;
}

function startListening(): void {
  listening = true;
  teardown.push(whenDebugLogStops(stopListening));
  const onVisibility = () => {
    if (visible()) return;
    hiddenTimes++;
    pending.clear();
  };
  document.addEventListener('visibilitychange', onVisibility);
  teardown.push(() => document.removeEventListener('visibilitychange', onVisibility));
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const measures = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith('pn:')) continue;
        const what = entry.name.slice(3);
        const detail = (entry as PerformanceMeasure).detail as Record<string, number> | undefined;
        const seen: Seen = { what, ms: entry.duration, at: entry.startTime, detail: detail ?? undefined };
        recent.push(seen);
        if (recent.length > 50) recent.splice(0, recent.length - 50);
        // With the page's memory then: a tab about to die of its size says so in its last slow moments.
        if (entry.duration >= SLOW_UI_MS) debugNote('slow_ui', { what, ms: Math.round(entry.duration), n: detail?.messages ?? detail?.rows, ...debugMemory() });
      }
      draw();
    });
    measures.observe({ type: 'measure', buffered: false });
    teardown.push(() => measures.disconnect());
  } catch {
    // An older browser: the marks still go to the timeline.
  }
  if (!overlayOn()) return;
  try {
    const tasks = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks = { count: longTasks.count + 1, ms: longTasks.ms + entry.duration, longest: Math.max(longTasks.longest, entry.duration) };
      }
      draw();
    });
    tasks.observe({ type: 'longtask', buffered: true });
    teardown.push(() => tasks.disconnect());
  } catch {
    // No long-task timing here.
  }
  const box = document.createElement('pre');
  box.setAttribute('data-perf-overlay', '');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText =
    'position:fixed;right:8px;bottom:8px;z-index:2147483647;margin:0;padding:6px 8px;max-width:420px;font:11px/1.35 ui-monospace,monospace;background:rgba(0,0,0,.78);color:#e6e6e6;border-radius:6px;pointer-events:none;white-space:pre;transition:none';
  overlay = box;
  const attach = () => document.body.appendChild(box);
  if (document.body) attach();
  else window.addEventListener('DOMContentLoaded', attach, { once: true });
  teardown.push(() => {
    window.removeEventListener('DOMContentLoaded', attach);
    box.remove();
  });
  draw();
}
