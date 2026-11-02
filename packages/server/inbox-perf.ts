/**
 * The Inbox's performance timings, the server's side. Always on and invisible:
 *
 * - Every `/api/inbox/` answer carries a `Server-Timing` header: `app` (the whole handler) and the named phases
 *   the handler ran inside `perfPhase` (`rows`, `thread`, `disk`, `json`, ...). The browser's DevTools show it
 *   under Network → Timing. Nothing is stored and nothing leaves the computer.
 * - With the debug log on (`PLANNOTATOR_INBOX_DEBUG=1` or `inboxDebug: true`), a request slower than
 *   `INBOX_SLOW_REQUEST_MS` writes one `slow_req` line with its phases, and a stalled event loop (a timer
 *   firing late by `INBOX_LOOP_STALL_MS` or more: synchronous work no request owns) writes a `loop_stall` line.
 *
 * Cost when nothing reads it: two clock reads and one header per request (measured in the perf study).
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** A request at least this slow writes a `slow_req` line (debug log on only). */
export const INBOX_SLOW_REQUEST_MS = 200;
/** A timer at least this late writes a `loop_stall` line (debug log on only). */
export const INBOX_LOOP_STALL_MS = 100;
const LOOP_TICK_MS = 250;

interface Phase {
  name: string;
  dur: number;
}

const phases = new AsyncLocalStorage<Phase[]>();

/** Run `fn` as a named phase of the current request (a no-op outside one). Synchronous work only. */
export function perfPhase<T>(name: string, fn: () => T): T {
  const list = phases.getStore();
  if (!list) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    list.push({ name, dur: performance.now() - started });
  }
}

/** Header-safe: `rows;dur=12.3, json;dur=1.2, app;dur=14.0`. Repeated phases are summed. */
export function serverTimingHeader(list: readonly Phase[], total: number): string {
  const sums = new Map<string, number>();
  for (const p of list) sums.set(p.name, (sums.get(p.name) ?? 0) + p.dur);
  const parts = [...sums.entries()].map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`);
  parts.push(`app;dur=${total.toFixed(1)}`);
  return parts.join(", ");
}

export interface SlowRequest {
  route: string;
  ms: number;
  phases: Record<string, number>;
}

/**
 * `handle`, timed: phases are collected for each `/api/inbox/` request and sent back as `Server-Timing`.
 * `onSlow` (the debug log's, when it is on) hears of a request slower than `INBOX_SLOW_REQUEST_MS`.
 */
export function withServerTiming<Via extends string>(
  handle: (req: Request, via: Via) => Promise<Response>,
  routeOf: (pathname: string) => string,
  onSlow: ((slow: SlowRequest) => void) | null,
): (req: Request, via: Via) => Promise<Response> {
  return (req, via) => {
    const list: Phase[] = [];
    const started = performance.now();
    return phases.run(list, async () => {
      const response = await handle(req, via);
      const total = performance.now() - started;
      let pathname = "";
      try {
        pathname = new URL(req.url, "http://127.0.0.1").pathname;
      } catch {
        return response;
      }
      if (!pathname.startsWith("/api/inbox/")) return response;
      try {
        response.headers.set("Server-Timing", serverTimingHeader(list, total));
      } catch {
        // Headers that cannot change: the answer matters more than the timing.
      }
      if (onSlow && total >= INBOX_SLOW_REQUEST_MS) {
        const named: Record<string, number> = {};
        for (const p of list) named[p.name] = Math.round((named[p.name] ?? 0) + p.dur);
        try {
          onSlow({ route: routeOf(pathname), ms: Math.round(total), phases: named });
        } catch {
          // The log never gets in the Inbox's way.
        }
      }
      return response;
    });
  };
}

/**
 * Notes a stalled event loop: a timer meant to fire every 250 ms that fires late by `INBOX_LOOP_STALL_MS` or more.
 * Only started with the debug log on. Returns the stop.
 */
export function watchLoopStalls(onStall: (ms: number) => void): () => void {
  let expected = performance.now() + LOOP_TICK_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - expected;
    expected = now + LOOP_TICK_MS;
    if (late >= INBOX_LOOP_STALL_MS) {
      try {
        onStall(Math.round(late));
      } catch {
        // Never in the way.
      }
    }
  }, LOOP_TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
