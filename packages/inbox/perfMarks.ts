/**
 * The Inbox window's performance marks. Always on and invisible: each key interaction leaves one
 * `performance.measure` named `pn:<what>` (Chrome DevTools → Performance shows them under Timings), from the
 * moment it starts to the next frame the browser draws after it, which is what the person waits for.
 *
 *   pn:first-list      page start → the first list drawn
 *   pn:thread-open     a thread's read starts → its messages drawn (detail: messages, open = shown in full)
 *   pn:record-refresh  an event from the server → the list and the open thread read again and drawn
 *   pn:theme           the light/dark switch → the next frame (pn:theme-settled: → the main thread is free again)
 *   pn:expand-all      "Expand all messages" → drawn
 *   pn:keystroke       a key in the reply box → the next frame; only noted when ≥ 50 ms
 *
 * Off by default, and only for the person who turns them on:
 * - With the debug log on, an interaction slower than SLOW_UI_MS is also written to it (`slow_ui`).
 * - `localStorage['plannotator-inbox-perf'] = '1'` (or `#perf` once in the address) shows a small overlay with the
 *   last timings and the long tasks. Nothing is sent anywhere else.
 *
 * Entries are cleared as they are made, so a window open for weeks keeps none: an observer hears each one first.
 */
import { debugNote } from './debugLog';

export type PerfWhat = 'first-list' | 'thread-open' | 'record-refresh' | 'theme' | 'theme-settled' | 'expand-all' | 'keystroke';

/** An interaction at least this slow is written to the debug log (when it is on). */
export const SLOW_UI_MS = 100;
const KEYSTROKE_NOTE_MS = 50;
const OVERLAY_KEY = 'plannotator-inbox-perf';

const supported = typeof performance !== 'undefined' && typeof performance.measure === 'function' && typeof window !== 'undefined';

/** After the next frame is drawn: a rAF, then a task (the frame's paint happens between them). */
export function afterNextFrame(done: (now: number) => void): void {
  if (!supported) return;
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => done(performance.now());
    channel.port2.postMessage(0);
  });
}

/** Leave a `pn:<what>` measure from `start` (a `performance.now()` time) to now. */
export function perfMeasure(what: PerfWhat, start: number, detail?: Record<string, number>): void {
  if (!supported) return;
  try {
    const end = performance.now();
    performance.measure(`pn:${what}`, { start, end, detail });
    // Heard by the observer below, then dropped: the timeline never grows.
    performance.clearMeasures(`pn:${what}`);
  } catch {
    // Never in the way.
  }
}

/** From `start` to the next frame drawn. */
export function perfUntilNextFrame(what: PerfWhat, start: number, detail?: Record<string, number>): void {
  afterNextFrame(() => perfMeasure(what, start, detail));
}

/** An interaction that starts now: to the next frame, then (theme only) to the first idle moment after it. */
export function perfInteraction(what: 'theme' | 'expand-all', detail?: Record<string, number>): void {
  if (!supported) return;
  const start = performance.now();
  afterNextFrame(() => {
    perfMeasure(what, start, detail);
    if (what === 'theme') {
      const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
      if (idle) idle(() => perfMeasure('theme-settled', start), { timeout: 5000 });
    }
  });
}

/** A key in the reply box: `timeStamp` is the event's. Only a slow one leaves a measure. */
export function perfKeystroke(timeStamp: number): void {
  if (!supported) return;
  afterNextFrame((now) => {
    if (now - timeStamp >= KEYSTROKE_NOTE_MS) perfMeasure('keystroke', timeStamp);
  });
}

/** Thread reads that started and have not been drawn yet, by thread id (the first read of each open only). */
const opening = new Map<string, number>();
export function perfThreadOpenStart(threadId: string): void {
  if (supported && !opening.has(threadId)) opening.set(threadId, performance.now());
}
export function perfThreadOpenDrawn(threadId: string, detail: Record<string, number>): void {
  const start = opening.get(threadId);
  if (start === undefined) return;
  opening.delete(threadId);
  perfUntilNextFrame('thread-open', start, detail);
}
export function perfThreadOpenDropped(threadId: string): void {
  opening.delete(threadId);
}

let firstListDone = false;
/** The first list drawn after the page started (time 0 is the navigation's start). */
export function perfFirstList(rows: number): void {
  if (firstListDone) return;
  firstListDone = true;
  perfUntilNextFrame('first-list', 0, { rows });
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

function overlayOn(): boolean {
  try {
    if (window.location.hash.includes('perf')) window.localStorage.setItem(OVERLAY_KEY, '1');
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

function startListening(): void {
  if (!supported || typeof PerformanceObserver === 'undefined') return;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith('pn:')) continue;
        const what = entry.name.slice(3);
        const detail = (entry as PerformanceMeasure).detail as Record<string, number> | undefined;
        const seen: Seen = { what, ms: entry.duration, at: entry.startTime, detail: detail ?? undefined };
        recent.push(seen);
        if (recent.length > 50) recent.splice(0, recent.length - 50);
        if (entry.duration >= SLOW_UI_MS) debugNote('slow_ui', { what, ms: Math.round(entry.duration), n: detail?.messages ?? detail?.rows });
      }
      draw();
    }).observe({ type: 'measure', buffered: false });
  } catch {
    // An older browser: the marks still go to the timeline.
  }
  if (!overlayOn()) return;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks = { count: longTasks.count + 1, ms: longTasks.ms + entry.duration, longest: Math.max(longTasks.longest, entry.duration) };
      }
      draw();
    }).observe({ type: 'longtask', buffered: true });
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
  draw();
}

startListening();
