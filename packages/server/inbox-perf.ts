import { AsyncLocalStorage } from "node:async_hooks";

export const INBOX_SLOW_REQUEST_MS = 200;
export const INBOX_LOOP_STALL_MS = 100;
/** A block is measured from the tick it delays, so up to this many ms of a block can go unseen. */
export const INBOX_LOOP_TICK_MS = 250;

interface Phase {
  name: string;
  dur: number;
}

interface Timed {
  list: Phase[];
  route: string;
}

const phases = new AsyncLocalStorage<Timed>();

let slowest: { name: string; ms: number; route: string | null } | null = null;
let slowestHandler: { ms: number; route: string } | null = null;
let lastSection: { name: string; route: string | null } | null = null;

const noteSection = (name: string, ms: number, route: string | null): void => {
  lastSection = { name, route };
  if (!slowest || ms > slowest.ms) slowest = { name, ms, route };
};

export function syncSection<T>(name: string, fn: () => T): T {
  if (loopWatches === 0) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    noteSection(name, performance.now() - started, phases.getStore()?.route ?? null);
  }
}

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

let timedServers = 0;

export function retainPerfPhases(): () => void {
  timedServers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    timedServers--;
  };
}

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

export function serverTimingHeader(list: readonly Phase[], total: number): string {
  const sums = new Map<string, number>();
  for (const p of list) sums.set(p.name, (sums.get(p.name) ?? 0) + p.dur);
  const parts = [...sums.entries()].map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`);
  parts.push(`app;dur=${total.toFixed(1)}`);
  return parts.join(", ");
}

/** Routes that wait or stream by design: they get Server-Timing but never a `slow_req` line, which would only repeat their `req_end`. */
const WAITING_ROUTE = /^\/api\/inbox\/(?:bridge\/poll$|events$|m\/|uploads(?:\/|$))/;

export interface SlowRequest {
  route: string;
  ms: number;
  phases: Record<string, number>;
}

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

let loopWatches = 0;
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
