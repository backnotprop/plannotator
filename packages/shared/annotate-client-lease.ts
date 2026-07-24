/**
 * Annotate client-lease tracker — pure last-client abandonment detector.
 *
 * Local direct structured annotate gates (`plannotator annotate --gate --json`)
 * block a CLI/hook caller on `waitForDecision()`. If the browser tab that owns
 * the decision goes away without ever sending `/api/exit`/`/api/approve`
 * (closed tab, killed terminal) the gate would otherwise hang forever.
 *
 * This tracker gives the server a safe, connection-based signal instead: it
 * counts concurrently connected SSE clients (normally exactly one — the tab's
 * own client-lease stream), and once the *last* one disconnects, waits a grace
 * period (default 30s) for a reconnect (tab refresh) before firing a one-shot
 * expiry callback. A tab that never connects at all never expires — there is
 * nothing to abandon yet.
 *
 * The grace clock only starts once the server's transport actually reports a
 * disconnect; this tracker has no notion of the network itself. A clean close
 * (tab closed, navigated away) reports promptly. An abrupt loss — killed
 * process, unplugged network, a half-open TCP connection with no traffic —
 * is detected on a best-effort basis by the transport (e.g. failing
 * heartbeat writes) and is not bounded by `graceMs`: it can take longer than
 * the grace period for the transport to notice the peer is gone at all,
 * during which this tracker still believes a client is connected.
 *
 * Deliberately dependency-free: no fetch, no DOM, no framework. Bun and Pi
 * servers each wire this to their own SSE transport; the editor never talks
 * to it directly (see packages/editor/annotateClientLease.ts for the client
 * side of the wire protocol).
 */

/** Default reconnect grace period after the last client disconnects. */
export const ANNOTATE_CLIENT_LEASE_GRACE_MS = 30_000;

/** Default SSE heartbeat interval used by server transports. */
export const ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS = 5_000;

/** SSE route path shared by the Bun and Pi annotate servers and the editor client. */
export const ANNOTATE_CLIENT_LEASE_STREAM_PATH = "/api/annotate/client-lease";

/** First byte written once a client-lease stream is open and has acquired the tracker. */
export const ANNOTATE_CLIENT_LEASE_READY_COMMENT = ": ready\n\n";

/** Keep-alive comment written every heartbeat interval. */
export const ANNOTATE_CLIENT_LEASE_HEARTBEAT_COMMENT = ": heartbeat\n\n";

export type AnnotateClientLeaseTimerHandle = unknown;

export interface AnnotateClientLeaseTrackerOptions {
  /** Milliseconds to wait after the last client disconnects before expiring. Default 30_000. */
  graceMs?: number;
  /** Injectable scheduler — production uses real timers, tests supply a virtual clock. */
  setTimer?: (callback: () => void, ms: number) => AnnotateClientLeaseTimerHandle;
  /** Injectable timer cancellation matching `setTimer`. */
  clearTimer?: (handle: AnnotateClientLeaseTimerHandle) => void;
}

export interface AnnotateClientLeaseTracker {
  /**
   * Register a newly connected client. Returns a release callback to call on
   * disconnect — idempotent, safe to call more than once for the same client.
   */
  acquire: () => () => void;
  /**
   * Permanently stop tracking — e.g. an explicit decision (approve/feedback/
   * exit) already resolved the gate, so abandonment no longer matters. Safe
   * to call repeatedly, and safe to call before any client ever connects.
   */
  cancel: () => void;
  /**
   * Close every live stream session created against this tracker. Servers call
   * this while shutting down: releasing the slot is not enough, because each
   * session also owns a heartbeat timer and an open response that would
   * otherwise outlive the session (in a long-lived host process, forever).
   */
  closeSessions: () => void;
  /** Number of currently connected (not yet released) clients. */
  activeCount: () => number;
  /** Whether the one-shot expiry callback has already fired. */
  isExpired: () => boolean;
  /** @internal Session bookkeeping for `closeSessions`. */
  registerSession: (session: { close: () => void }) => () => void;
}

/**
 * Create a tracker that invokes `onExpire` at most once, after the last
 * connected client has stayed disconnected for the full grace period.
 */
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
      // A (re)connect always cancels a pending expiry — including the very
      // first connect, which is a no-op here since none is scheduled yet.
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
  /** Tracker owning this session's presence slot. */
  tracker: AnnotateClientLeaseTracker;
  /**
   * End the underlying response, if the transport can. Called on close so a
   * server-side shutdown actually finishes the stream instead of leaving the
   * client hanging on a connection nobody heartbeats any more.
   */
  endStream?: () => void;
  /** Transport write. Must throw (or be replaced) when the peer is gone. */
  write: (chunk: string) => void;
  /** Heartbeat interval. Defaults to `ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS`. */
  heartbeatMs?: number;
  /** Injectable repeating scheduler; production uses real timers. */
  setHeartbeat?: (callback: () => void, ms: number) => AnnotateClientLeaseTimerHandle;
  /** Injectable cancellation matching `setHeartbeat`. */
  clearHeartbeat?: (handle: AnnotateClientLeaseTimerHandle) => void;
}

export interface AnnotateClientLeaseStreamSession {
  /** Stop heartbeating and release the presence slot. Idempotent. */
  close: () => void;
  /** Whether the session has already been closed. */
  isClosed: () => boolean;
}

/**
 * Wire one connected client-lease stream to a tracker.
 *
 * Runtime-agnostic on purpose: the Bun server passes a `ReadableStream`
 * controller enqueue, the Pi server passes `res.write`, and tests pass a
 * writer that throws. Keeping the acquire/ready/heartbeat/release sequence in
 * one place is what makes the two runtimes provably identical, including the
 * case that is otherwise unreachable from an integration test: a write that
 * fails must close the session, because a stream that can no longer be written
 * to is a client that is no longer present. Leaving the slot held there would
 * make the gate un-dismissable for the rest of the session.
 */
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
