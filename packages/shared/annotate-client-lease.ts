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
    try {
      options.endStream?.();
    } catch {
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
