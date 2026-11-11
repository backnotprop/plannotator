/**
 * Last-client abandonment detector for annotate gates: counts connected SSE clients and, after the last disconnects, waits a grace period before a one-shot expiry. A tab that never connects never expires.
 * The grace clock starts only when the transport reports a disconnect; an abrupt loss may be noticed later than `graceMs`.
 */

export const ANNOTATE_CLIENT_LEASE_GRACE_MS = 30_000;

export const ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS = 5_000;

export const ANNOTATE_CLIENT_LEASE_STREAM_PATH = "/api/annotate/client-lease";

export const ANNOTATE_CLIENT_LEASE_READY_COMMENT = ": ready\n\n";

export const ANNOTATE_CLIENT_LEASE_HEARTBEAT_COMMENT = ": heartbeat\n\n";

export type AnnotateClientLeaseTimerHandle = unknown;

export interface AnnotateClientLeaseTrackerOptions {
  graceMs?: number;
  setTimer?: (callback: () => void, ms: number) => AnnotateClientLeaseTimerHandle;
  clearTimer?: (handle: AnnotateClientLeaseTimerHandle) => void;
}

export interface AnnotateClientLeaseTracker {
  acquire: () => () => void;
  cancel: () => void;
  /** Called on shutdown: each session owns a heartbeat timer and an open response that would otherwise outlive it. */
  closeSessions: () => void;
  activeCount: () => number;
  isExpired: () => boolean;
  registerSession: (session: { close: () => void }) => () => void;
}

export function createAnnotateClientLeaseTracker(
  onExpire: () => void,
  options: AnnotateClientLeaseTrackerOptions = {},
): AnnotateClientLeaseTracker {
  const graceMs = options.graceMs ?? ANNOTATE_CLIENT_LEASE_GRACE_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let active = 0;
  let cancelled = false;
  let expired = false;
  let graceTimer: AnnotateClientLeaseTimerHandle | null = null;
  const sessions = new Set<{ close: () => void }>();

  function clearGraceTimer(): void {
    if (graceTimer !== null) {
      clearTimer(graceTimer);
      graceTimer = null;
    }
  }

  function scheduleExpiry(): void {
    clearGraceTimer();
    graceTimer = setTimer(() => {
      graceTimer = null;
      if (cancelled || expired || active > 0) return;
      expired = true;
      onExpire();
    }, graceMs);
  }

  return {
    acquire() {
      if (cancelled || expired) return () => {};

      active += 1;
      clearGraceTimer();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Always account for the disconnect, so activeCount() stays truthful
        // after cancellation; only the expiry scheduling is suppressed.
        active = Math.max(0, active - 1);
        if (cancelled || expired) return;
        if (active === 0) scheduleExpiry();
      };
    },
    cancel() {
      cancelled = true;
      clearGraceTimer();
    },
    closeSessions() {
      // close() unregisters, so iterate a snapshot.
      for (const session of [...sessions]) session.close();
    },
    activeCount() {
      return active;
    },
    isExpired() {
      return expired;
    },
    registerSession(session) {
      sessions.add(session);
      return () => sessions.delete(session);
    },
  };
}

export interface AnnotateClientLeaseStreamSessionOptions {
  tracker: AnnotateClientLeaseTracker;
  endStream?: () => void;
  write: (chunk: string) => void;
  heartbeatMs?: number;
  setHeartbeat?: (callback: () => void, ms: number) => AnnotateClientLeaseTimerHandle;
  clearHeartbeat?: (handle: AnnotateClientLeaseTimerHandle) => void;
}

export interface AnnotateClientLeaseStreamSession {
  close: () => void;
  isClosed: () => boolean;
}

/** A failed write must close the session: a stream that cannot be written to is a client no longer present, and a held slot would make the gate un-dismissable. */
export function createAnnotateClientLeaseStreamSession(
  options: AnnotateClientLeaseStreamSessionOptions,
): AnnotateClientLeaseStreamSession {
  const heartbeatMs = options.heartbeatMs ?? ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS;
  const setHeartbeat = options.setHeartbeat ?? ((callback, ms) => setInterval(callback, ms));
  const clearHeartbeat =
    options.clearHeartbeat ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  const release = options.tracker.acquire();
  let closed = false;
  let heartbeat: AnnotateClientLeaseTimerHandle | null = null;

  function close(): void {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) {
      clearHeartbeat(heartbeat);
      heartbeat = null;
    }
    unregister();
    release();
    // Ending an already-dead stream throws in both runtimes; that is exactly
    // the case where there is nothing left to end.
    try {
      options.endStream?.();
    } catch {
      // ignore
    }
  }

  const unregister = options.tracker.registerSession({ close: () => close() });

  try {
    options.write(ANNOTATE_CLIENT_LEASE_READY_COMMENT);
  } catch {
    close();
    return { close, isClosed: () => closed };
  }

  heartbeat = setHeartbeat(() => {
    if (closed) return;
    try {
      options.write(ANNOTATE_CLIENT_LEASE_HEARTBEAT_COMMENT);
    } catch {
      close();
    }
  }, heartbeatMs);

  return { close, isClosed: () => closed };
}
