/**
 * The Inbox's performance timings, the server's side. Only with the debug log on (`PLANNOTATOR_INBOX_DEBUG=1` or
 * `inboxDebug: true`); off, the server never wraps its handler and `perfPhase` is one number compare:
 *
 * - Every `/api/inbox/` answer carries a `Server-Timing` header: `app` (the whole handler) and the named phases
 *   the handler ran inside `perfPhase` (`rows`, `thread`, `disk`, `json`, ...). The browser's DevTools show it
 *   under Network → Timing.
 * - A request slower than `INBOX_SLOW_REQUEST_MS` writes one `slow_req` line with its phases, and a stalled event
 *   loop (a timer firing late by `INBOX_LOOP_STALL_MS` or more: synchronous work no request owns) writes a
 *   `loop_stall` line.
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
/** Servers in this process timing their requests (debug log on). At 0, `perfPhase` just runs `fn`. */
let timedServers = 0;

/** A server with the debug log on times its requests until the returned release (its stop). */
export function retainPerfPhases(): () => void {
  timedServers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    timedServers--;
  };
}

/** Run `fn` as a named phase of the current request (a no-op outside one, and while no server times). Synchronous work only. */
export function perfPhase<T>(name: string, fn: () => T): T {
  if (timedServers === 0) return fn();
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

/**
 * Routes that wait or stream by design: an agent's bridge long-poll (up to 25 s), the event stream, a linked
 * machine's forward, an upload. They still get Server-Timing; a `slow_req` line for them would only repeat the
 * request's own `req_end` and bury the slow reads.
 */
const WAITING_ROUTE = /^\/api\/inbox\/(?:bridge\/|events$|m\/|uploads(?:\/|$))/;

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
      if (onSlow && total >= INBOX_SLOW_REQUEST_MS && !WAITING_ROUTE.test(pathname)) {
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
let loopWatches = 0;
/** How many loop watches run in this process (tests: none while every Inbox has the debug log off). */
export function runningLoopWatches(): number {
  return loopWatches;
}

export function watchLoopStalls(onStall: (ms: number) => void): () => void {
  loopWatches++;
  let stopped = false;
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
  return () => {
    if (stopped) return;
    stopped = true;
    loopWatches--;
    clearInterval(timer);
  };
}
