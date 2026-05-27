export interface SessionRequestContext {
  disableIdleTimeout?: () => void;
  upgradeWebSocket?: (data: unknown) => Response | undefined;
}

export type SessionEventFamily = "external-annotations" | "agent-jobs" | "session-revision";

export type SessionEventPublisher = (
  family: SessionEventFamily,
  event: unknown,
) => void;

export type SessionSnapshotProvider = () => unknown | Promise<unknown>;

export type SessionSnapshotRegistrar = (
  family: SessionEventFamily,
  provider: SessionSnapshotProvider,
) => () => void;

export interface SessionEventBridge {
  publishEvent: SessionEventPublisher;
  registerSnapshotProvider: SessionSnapshotRegistrar;
}

export type SessionRequestHandler = (
  req: Request,
  url: URL,
  context?: SessionRequestContext,
) => Response | Promise<Response>;

/**
 * Manages a resolvable decision cycle for session servers.
 * Each deny/feedback starts a new cycle; approve/exit is final.
 *
 * Invariant: promise() returns a new Promise object after startNew().
 * The decision loop in session-factory uses reference identity to detect
 * when no new cycle was started (same promise === loop should exit).
 */
export function createDecisionCycle<T>() {
  let current: { promise: Promise<T>; resolve: (result: T) => void };
  function start() {
    let resolve: (result: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    current = { promise, resolve: resolve! };
  }
  start();
  return {
    promise: () => current.promise,
    resolve: (result: T) => current.resolve(result),
    startNew: () => start(),
  };
}

/**
 * Resolve the current decision cycle. If the session has an agent origin,
 * start a new cycle and include `awaitingResubmission: true` in the response.
 */
const NON_AGENT_ORIGINS = new Set(["plannotator-frontend"]);

export function resolveAndCycle<T>(
  cycle: ReturnType<typeof createDecisionCycle<T>>,
  result: T,
  origin: string | undefined,
): { awaitingResubmission?: true } {
  cycle.resolve(result);
  if (origin && !NON_AGENT_ORIGINS.has(origin)) {
    cycle.startNew();
    return { awaitingResubmission: true };
  }
  return {};
}
