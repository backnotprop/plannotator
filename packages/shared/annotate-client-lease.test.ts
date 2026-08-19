import { describe, expect, test } from "bun:test";

import {
  ANNOTATE_CLIENT_LEASE_GRACE_MS,
  ANNOTATE_CLIENT_LEASE_HEARTBEAT_COMMENT,
  ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS,
  ANNOTATE_CLIENT_LEASE_READY_COMMENT,
  createAnnotateClientLeaseStreamSession,
  createAnnotateClientLeaseTracker,
} from "./annotate-client-lease";

/**
 * Deterministic virtual clock — tests drive expiry by advancing simulated
 * time instead of sleeping on the real 30s grace period. Timers fire in
 * scheduled order when `advance()` crosses their deadline.
 */
function createFakeScheduler() {
  let nextId = 1;
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    setTimer: (callback: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (id: number): void => {
      timers.delete(id);
    },
    advance(ms: number): void {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

describe("annotate client-lease tracker: defaults", () => {
  test("exposes the documented heartbeat and grace constants", () => {
    expect(ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS).toBe(5_000);
    expect(ANNOTATE_CLIENT_LEASE_GRACE_MS).toBe(30_000);
  });
});

describe("annotate client-lease tracker: never-connected", () => {
  test("never expires when no client ever connects", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS * 10);

    expect(expireCalls).toBe(0);
    expect(tracker.activeCount()).toBe(0);
    expect(tracker.isExpired()).toBe(false);
  });
});

describe("annotate client-lease tracker: last disconnect expiry", () => {
  test("expires exactly at the grace deadline after the only client disconnects", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    const release = tracker.acquire();
    expect(tracker.activeCount()).toBe(1);

    release();
    expect(tracker.activeCount()).toBe(0);

    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS - 1);
    expect(expireCalls).toBe(0);
    expect(tracker.isExpired()).toBe(false);

    scheduler.advance(1);
    expect(expireCalls).toBe(1);
    expect(tracker.isExpired()).toBe(true);
  });

  test("honors a custom graceMs override", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer, graceMs: 1_000 });

    tracker.acquire()();
    scheduler.advance(999);
    expect(expireCalls).toBe(0);
    scheduler.advance(1);
    expect(expireCalls).toBe(1);
  });
});

describe("annotate client-lease tracker: reconnect cancel", () => {
  test("a reconnect before the grace deadline cancels the pending expiry", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    tracker.acquire()();
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS / 2);
    expect(expireCalls).toBe(0);

    // Reconnect cancels the pending timer — advancing past the original
    // deadline must not fire it.
    const release = tracker.acquire();
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS);
    expect(expireCalls).toBe(0);
    expect(tracker.activeCount()).toBe(1);

    // A fresh disconnect starts its own full grace window.
    release();
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS - 1);
    expect(expireCalls).toBe(0);
    scheduler.advance(1);
    expect(expireCalls).toBe(1);
  });
});

describe("annotate client-lease tracker: multiple clients", () => {
  test("only expires once every active client has released", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    const releaseFirst = tracker.acquire();
    const releaseSecond = tracker.acquire();
    expect(tracker.activeCount()).toBe(2);

    releaseFirst();
    expect(tracker.activeCount()).toBe(1);
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS * 2);
    expect(expireCalls).toBe(0);

    releaseSecond();
    expect(tracker.activeCount()).toBe(0);
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS - 1);
    expect(expireCalls).toBe(0);
    scheduler.advance(1);
    expect(expireCalls).toBe(1);
  });

  test("release is idempotent — calling it twice does not double-decrement", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    const releaseFirst = tracker.acquire();
    tracker.acquire();
    expect(tracker.activeCount()).toBe(2);

    releaseFirst();
    releaseFirst();
    releaseFirst();
    expect(tracker.activeCount()).toBe(1);
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS);
    expect(expireCalls).toBe(0);
  });
});

describe("annotate client-lease tracker: cancel", () => {
  test("cancel() permanently stops tracking, even mid-grace", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    tracker.acquire()();
    tracker.cancel();
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS * 5);
    expect(expireCalls).toBe(0);

    // Acquiring after cancel is a safe no-op — it must not resurrect tracking.
    const release = tracker.acquire();
    expect(tracker.activeCount()).toBe(0);
    release();
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS * 5);
    expect(expireCalls).toBe(0);
  });

  test("activeCount() stays truthful when a client disconnects after cancel()", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    const release = tracker.acquire();
    expect(tracker.activeCount()).toBe(1);

    tracker.cancel();
    release();

    expect(tracker.activeCount()).toBe(0);
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS * 5);
    expect(expireCalls).toBe(0);
  });

  test("cancel() is idempotent and safe before any client ever connects", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    tracker.cancel();
    tracker.cancel();
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS * 5);
    expect(expireCalls).toBe(0);
    expect(tracker.isExpired()).toBe(false);
  });
});

describe("annotate client-lease tracker: once", () => {
  test("the expiry callback fires at most once", () => {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    tracker.acquire()();
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS);
    expect(expireCalls).toBe(1);

    // Further time passing, or redundant releases, must not refire it.
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS * 10);
    expect(expireCalls).toBe(1);
    expect(tracker.isExpired()).toBe(true);
  });
});

describe("annotate client-lease stream session", () => {
  function setup(options: { failReady?: boolean; failHeartbeatAfter?: number } = {}) {
    const scheduler = createFakeScheduler();
    let expireCalls = 0;
    const tracker = createAnnotateClientLeaseTracker(() => {
      expireCalls += 1;
    }, { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

    const written: string[] = [];
    let heartbeats = 0;
    const session = createAnnotateClientLeaseStreamSession({
      tracker,
      heartbeatMs: ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS,
      // The fake scheduler is one-shot, so re-arm to emulate setInterval.
      setHeartbeat: (callback, ms) => {
        const repeat = () => {
          scheduler.setTimer(repeat, ms);
          callback();
        };
        return scheduler.setTimer(repeat, ms);
      },
      clearHeartbeat: (handle) => scheduler.clearTimer(handle as number),
      write: (chunk) => {
        if (chunk === ANNOTATE_CLIENT_LEASE_READY_COMMENT && options.failReady) {
          throw new Error("peer gone");
        }
        if (chunk === ANNOTATE_CLIENT_LEASE_HEARTBEAT_COMMENT) {
          heartbeats += 1;
          if (options.failHeartbeatAfter !== undefined && heartbeats > options.failHeartbeatAfter) {
            throw new Error("peer gone");
          }
        }
        written.push(chunk);
      },
    });

    return { scheduler, tracker, session, written, expireCalls: () => expireCalls };
  }

  test("acquires the slot and writes the ready comment on connect", () => {
    const { tracker, written, session } = setup();

    expect(written).toEqual([ANNOTATE_CLIENT_LEASE_READY_COMMENT]);
    expect(tracker.activeCount()).toBe(1);
    expect(session.isClosed()).toBe(false);
  });

  test("heartbeats on the configured interval while connected", () => {
    const { scheduler, written, tracker, expireCalls } = setup();

    // One advance per interval: the fake scheduler fires only timers that were
    // already due when it was called, so a re-armed heartbeat needs its own tick.
    scheduler.advance(ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS);
    scheduler.advance(ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS);
    scheduler.advance(ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS);

    expect(written.filter((c) => c === ANNOTATE_CLIENT_LEASE_HEARTBEAT_COMMENT)).toHaveLength(3);
    expect(tracker.activeCount()).toBe(1);
    expect(expireCalls()).toBe(0);
  });

  test("close() releases the slot once and starts the grace period", () => {
    const { scheduler, session, tracker, expireCalls } = setup();

    session.close();
    session.close();

    expect(session.isClosed()).toBe(true);
    expect(tracker.activeCount()).toBe(0);
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS);
    expect(expireCalls()).toBe(1);
  });

  test("a failed ready write closes the session so the gate stays dismissable", () => {
    const { scheduler, session, tracker, expireCalls } = setup({ failReady: true });

    expect(session.isClosed()).toBe(true);
    expect(tracker.activeCount()).toBe(0);
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS);
    expect(expireCalls()).toBe(1);
  });

  test("a failed heartbeat write releases the slot instead of holding it forever", () => {
    const { scheduler, session, tracker, expireCalls } = setup({ failHeartbeatAfter: 1 });

    scheduler.advance(ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS);
    expect(tracker.activeCount()).toBe(1);

    scheduler.advance(ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS);
    expect(session.isClosed()).toBe(true);
    expect(tracker.activeCount()).toBe(0);

    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS);
    expect(expireCalls()).toBe(1);
  });

  test("closeSessions() ends every live session, so shutdown leaves nothing running", () => {
    const { scheduler, tracker, session, written, expireCalls } = setup();

    tracker.cancel();
    tracker.closeSessions();

    expect(session.isClosed()).toBe(true);
    expect(tracker.activeCount()).toBe(0);
    scheduler.advance(ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS * 5);
    expect(written).toEqual([ANNOTATE_CLIENT_LEASE_READY_COMMENT]);
    // Cancelled means abandonment no longer matters: no expiry may fire.
    scheduler.advance(ANNOTATE_CLIENT_LEASE_GRACE_MS);
    expect(expireCalls()).toBe(0);
  });

  test("close() ends the underlying stream exactly once", () => {
    const scheduler = createFakeScheduler();
    const tracker = createAnnotateClientLeaseTracker(() => {}, {
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });
    let ended = 0;
    const session = createAnnotateClientLeaseStreamSession({
      tracker,
      write: () => {},
      endStream: () => {
        ended += 1;
      },
    });

    session.close();
    session.close();

    expect(ended).toBe(1);
  });

  test("no heartbeat is written after close", () => {
    const { scheduler, session, written } = setup();

    session.close();
    scheduler.advance(ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS * 5);

    expect(written).toEqual([ANNOTATE_CLIENT_LEASE_READY_COMMENT]);
  });
});
