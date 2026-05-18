import { describe, expect, test } from "vitest";
import { daemonStatusFixture, sessionSummary } from "../../testing/fixtures/daemon";
import { applyDaemonEvent, createInitialDaemonDebugState } from "./event-store";

describe("daemon debug event store reducer", () => {
  test("applies snapshot events as the canonical daemon state", () => {
    const state = createInitialDaemonDebugState();
    const session = sessionSummary("plan", 1);

    applyDaemonEvent(state, {
      type: "snapshot",
      at: "2026-05-17T12:00:01.000Z",
      status: daemonStatusFixture,
      sessions: [session],
    });

    expect(state.status).toBe(daemonStatusFixture);
    expect(state.sessions).toEqual([session]);
    expect(state.events).toHaveLength(1);
  });

  test("tracks lifecycle updates and removes terminal sessions", () => {
    const state = createInitialDaemonDebugState();
    const session = sessionSummary("review", 2);

    applyDaemonEvent(state, {
      type: "session-created",
      at: "2026-05-17T12:00:01.000Z",
      session,
    });
    expect(state.sessions).toEqual([session]);

    applyDaemonEvent(state, {
      type: "session-updated",
      at: "2026-05-17T12:00:02.000Z",
      session: { ...session, status: "completed" },
    });

    expect(state.sessions).toEqual([]);
    expect(state.events.map((event) => event.type)).toEqual(["session-updated", "session-created"]);
  });

  test("records daemon errors without dropping prior events", () => {
    const state = createInitialDaemonDebugState();

    applyDaemonEvent(state, {
      type: "daemon-error",
      at: "2026-05-17T12:00:01.000Z",
      code: "internal-error",
      message: "session setup failed",
    });

    expect(state.lastError).toBe("session setup failed");
    expect(state.events[0].type).toBe("daemon-error");
  });
});
