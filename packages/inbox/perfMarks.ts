/**
 * Performance marks, only while the Inbox debug log is on: each key interaction leaves one `performance.measure` named `pn:<what>`, from its start to the next frame drawn.
 * Debug off, every entry point returns after one boolean check.
 */
import { debugLogOn, debugMemory, debugNote, whenDebugLogStops } from './debugLog';

export type PerfWhat = 'first-list' | 'thread-open' | 'record-refresh' | 'theme' | 'theme-settled' | 'expand-all' | 'keystroke';

export const SLOW_UI_MS = 100;
const KEYSTROKE_NOTE_MS = 50;
const OVERLAY_KEY = 'plannotator-inbox-perf';

const supported = typeof performance !== 'undefined' && typeof performance.measure === 'function' && typeof window !== 'undefined';
let listening = false;

export function perfOn(): boolean {
  if (!supported || !debugLogOn()) return false;
  if (!listening) startListening();
  return true;
}

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
let hiddenTimes = 0;

export interface PerfStart {
  at: number;
  hides: number;
}
export function perfStart(at?: number): PerfStart | null {
  if (!perfOn() || !visible()) return null;
  return { at: at ?? performance.now(), hides: hiddenTimes };
}

const pending = new Map<PerfWhat, object>();
let channel: MessageChannel | null = null;
const afterPaint: (() => void)[] = [];

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

function perfMeasure(what: PerfWhat, start: number, detail?: Record<string, number>): void {
  try {
    const end = performance.now();
    performance.measure(`pn:${what}`, { start, end, detail });
    // Heard by the observer below, then dropped: the timeline never grows.
    performance.clearMeasures(`pn:${what}`);
  } catch {
  }
}

export function perfUntilNextFrame(what: PerfWhat, start: PerfStart | null, detail?: Record<string, number>): void {
  if (!start || !perfOn()) return;
  afterNextFrame(what, start, () => perfMeasure(what, start.at, detail));
}

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

export function perfKeystroke(): void {
  if (!perfOn()) return;
  const start = perfStart((window.event as Event | undefined)?.timeStamp || performance.now());
  if (!start) return;
  afterNextFrame('keystroke', start, (now) => {
    if (now - start.at >= KEYSTROKE_NOTE_MS) perfMeasure('keystroke', start.at);
  });
}

let opening: { threadId: string; start: PerfStart } | null = null;
export function perfThreadOpenStart(threadId: string): void {
  if (opening?.threadId === threadId || !perfOn()) return;
  const start = perfStart();
  opening = start ? { threadId, start } : null;
}
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
export function perfFirstList(sections: readonly { threads: readonly unknown[] }[]): void {
  if (firstListDone) return;
  firstListDone = true;
  const start = perfStart(0);
  if (start) perfUntilNextFrame('first-list', start, { rows: sections.reduce((n, section) => n + section.threads.length, 0) });
}

interface Seen {
  what: string;
  ms: number;
  at: number;
  detail?: Record<string, number>;
}
const recent: Seen[] = [];
let longTasks = { count: 0, ms: 0, longest: 0 };
let overlay: HTMLElement | null = null;

/** Only an exact `perf=1` token turns the overlay on: agents choose parts of the hash, and a `linked=perf-report.html` must not switch anything on. */
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

const teardown: (() => void)[] = [];

function stopListening(): void {
  listening = false;
  for (const undo of teardown.splice(0)) {
    try {
      undo();
    } catch {
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
        if (entry.duration >= SLOW_UI_MS) debugNote('slow_ui', { what, ms: Math.round(entry.duration), n: detail?.messages ?? detail?.rows, ...debugMemory() });
      }
      draw();
    });
    measures.observe({ type: 'measure', buffered: false });
    teardown.push(() => measures.disconnect());
  } catch {
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
