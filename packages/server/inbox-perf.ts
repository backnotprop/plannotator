/**
 * The Inbox's performance timings, the server's side. Only with the debug log on (`PLANNOTATOR_INBOX_DEBUG=1` or
 * `inboxDebug: true`); off, the server never wraps its handler and `perfPhase` is one number compare:
 *
 * - Every `/api/inbox/` answer carries a `Server-Timing` header: `app` (the whole handler) and the named phases
 *   the handler ran inside `perfPhase` (`rows`, `thread`, `disk`, `json`, ...). The browser's DevTools show it
 *   under Network → Timing.
 * - A request slower than `INBOX_SLOW_REQUEST_MS` writes one `slow_req` line with its phases, and a stalled event
 *   loop (a timer firing late by `INBOX_LOOP_STALL_MS` or more: synchronous work no request owns) writes a
 *   `loop_stall` line. The line names the synchronous work that ran longest since the watch's last tick (`in`,
 *   with `in_ms`) and the request route it ran for (`route`), so a stall says what held the loop: each request's
 *   synchronous part, every `perfPhase`, and the heavy sections wrapped in `syncSection` (timer bodies, the
 *   tailscale CLI, the debug log's writes) count. When nothing measured ran long, `last` names the section entered
 *   last. Off (no loop watch), `syncSection` is one number compare.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** A request at least this slow writes a `slow_req` line (debug log on only). */
export const INBOX_SLOW_REQUEST_MS = 200;
/** A timer at least this late writes a `loop_stall` line (debug log on only). */
export const INBOX_LOOP_STALL_MS = 100;
/**
 * How often the loop watch ticks. A block is measured from the tick it delays, so a block only counts as a stall
 * when it runs `INBOX_LOOP_STALL_MS` past the next tick: up to this many ms of a block can go unseen.
 */
export const INBOX_LOOP_TICK_MS = 250;

interface Phase {
  name: string;
  dur: number;
}

/** A request's phases, and its route (the debug log's words for it), for the loop watch's attribution. */
interface Timed {
  list: Phase[];
  route: string;
}

const phases = new AsyncLocalStorage<Timed>();

// ── What held the loop (the `loop_stall` line's attribution) ──

/** Since the loop watch's last tick: the named synchronous section that ran longest, with its request's route. */
let slowest: { name: string; ms: number; route: string | null } | null = null;
/** Since the last tick: the request whose synchronous part (up to its first await) ran longest. */
let slowestHandler: { ms: number; route: string } | null = null;
/** The section entered last, whatever its length. */
let lastSection: { name: string; route: string | null } | null = null;

const noteSection = (name: string, ms: number, route: string | null): void => {
  lastSection = { name, route };
  if (!slowest || ms > slowest.ms) slowest = { name, ms, route };
};

/**
 * Run `fn`, synchronous work only, as a named section the loop watch can name when the loop stalls. Only with a
 * loop watch running (debug log on); otherwise it just runs `fn`.
 */
export function syncSection<T>(name: string, fn: () => T): T {
  if (loopWatches === 0) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    noteSection(name, performance.now() - started, phases.getStore()?.route ?? null);
  }
}

/**
 * What the loop watch names for a stall: `in`, the named section that ran longest since the last tick (`in_ms`),
 * and `route`, the request it ran for; `handler_ms` and `handler_route`, the longest synchronous part of a request
 * handler; `last`, when no section ran, the one entered last.
 */
export interface StallCause {
  in: string | null;
  in_ms?: number;
  route?: string | null;
  handler_ms?: number;
  handler_route?: string;
  last?: string | null;
}

function takeStallCause(): StallCause {
  const top = slowest;
  const handler = slowestHandler;
  slowest = null;
  slowestHandler = null;
  const cause: StallCause = top ? { in: top.name, in_ms: Math.round(top.ms), route: top.route } : { in: null, last: lastSection?.name ?? null, route: lastSection?.route ?? null };
  if (handler) {
    cause.handler_ms = Math.round(handler.ms);
    cause.handler_route = handler.route;
  }
  return cause;
}

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
  const timed = phases.getStore();
  if (!timed) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    const dur = performance.now() - started;
    timed.list.push({ name, dur });
    if (loopWatches > 0) noteSection(name, dur, timed.route);
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
const WAITING_ROUTE = /^\/api\/inbox\/(?:bridge\/poll$|events$|m\/|uploads(?:\/|$))/;

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
    let route = "";
    try {
      route = routeOf(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      // The handler answers a URL it cannot read; the timing names no route.
    }
    return phases.run({ list, route }, async () => {
      // The handler's synchronous part (up to its first await), for the loop watch.
      const syncStarted = performance.now();
      const pending = handle(req, via);
      if (loopWatches > 0) {
        const ms = performance.now() - syncStarted;
        if (!slowestHandler || ms > slowestHandler.ms) slowestHandler = { ms, route };
      }
      const response = await pending;
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
 * Notes a stalled event loop: a timer meant to fire every 250 ms that fires late by `INBOX_LOOP_STALL_MS` or more,
 * with what held it (`StallCause`). Only started with the debug log on. Returns the stop.
 */
let loopWatches = 0;
/** How many loop watches run in this process (tests: none while every Inbox has the debug log off). */
export function runningLoopWatches(): number {
  return loopWatches;
}

export function watchLoopStalls(onStall: (ms: number, cause: StallCause) => void): () => void {
  loopWatches++;
  let stopped = false;
  let expected = performance.now() + INBOX_LOOP_TICK_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - expected;
    expected = now + INBOX_LOOP_TICK_MS;
    const cause = takeStallCause();
    if (late >= INBOX_LOOP_STALL_MS) {
      try {
        onStall(Math.round(late), cause);
      } catch {
        // Never in the way.
      }
    }
  }, INBOX_LOOP_TICK_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    loopWatches--;
    if (loopWatches === 0) {
      slowest = null;
      slowestHandler = null;
      lastSection = null;
    }
    clearInterval(timer);
  };
}
