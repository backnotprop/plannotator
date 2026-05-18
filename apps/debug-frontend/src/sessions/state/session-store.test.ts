import { describe, expect, test } from "vitest";
import { sessionBootstrap, sessionListFixture } from "../../testing/fixtures/daemon";
import { createSessionStore } from "./session-store";

describe("session store", () => {
  test("keeps summaries keyed by session id", () => {
    const store = createSessionStore();

    store.getState().setSessions(sessionListFixture.sessions);

    expect(store.getState().sessionOrder).toEqual([
      "plan-session-1",
      "review-session-2",
      "annotate-session-3",
      "archive-session-4",
      "setup-goal-session-5",
    ]);
    expect(store.getState().sessions["review-session-2"].summary?.mode).toBe("review");
  });

  test("updates bootstrap state without touching other sessions", () => {
    const store = createSessionStore();
    store.getState().setSessions(sessionListFixture.sessions);

    store.getState().setBootstrap(sessionBootstrap("review", 2));

    expect(store.getState().sessions["review-session-2"].loadState).toBe("ready");
    expect(store.getState().sessions["plan-session-1"].loadState).toBe("idle");
  });

  test("uses Immer for nested status updates without mutating previous snapshots", () => {
    const store = createSessionStore();
    store.getState().setBootstrap(sessionBootstrap("plan", 1));
    const previousBootstrap = store.getState().sessions["plan-session-1"].bootstrap;

    store.getState().setSessionStatus("plan-session-1", "completed");

    expect(previousBootstrap?.session.status).toBe("active");
    expect(store.getState().sessions["plan-session-1"].bootstrap?.session.status).toBe("completed");
  });
});
