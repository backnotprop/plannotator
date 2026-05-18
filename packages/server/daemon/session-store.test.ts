import { describe, expect, test } from "bun:test";
import { DaemonSessionStore } from "./session-store";

describe("DaemonSessionStore", () => {
  test("creates stable session summaries", () => {
    const store = new DaemonSessionStore({ idFactory: () => "s1", now: () => 1_000 });
    const session = store.create({
      mode: "plan",
      url: "http://localhost:1234/s/s1",
      project: "repo",
      label: "plan-repo",
      origin: "claude-code",
      ttlMs: 60_000,
    });

    expect(session.id).toBe("s1");
    expect(session.status).toBe("active");
    expect(store.activeCount()).toBe(1);
    expect(store.totalCount()).toBe(1);
    expect(store.list()).toEqual([
      {
        id: "s1",
        mode: "plan",
        status: "active",
        url: "http://localhost:1234/s/s1",
        project: "repo",
        label: "plan-repo",
        origin: "claude-code",
        createdAt: "1970-01-01T00:00:01.000Z",
        updatedAt: "1970-01-01T00:00:01.000Z",
        expiresAt: "1970-01-01T00:01:01.000Z",
      },
    ]);
  });

  test("waiters resolve when a session completes and routing payloads are retained for result delivery", async () => {
    let now = 1_000;
    const store = new DaemonSessionStore({ idFactory: () => "s1", now: () => now });
    let disposed = false;
    store.create({
      mode: "review",
      url: "http://x/s/s1",
      project: "repo",
      label: "review",
      htmlContent: "<html></html>",
      handleRequest: () => new Response("ok"),
      dispose: () => { disposed = true; },
    });
    const waiting = store.waitForResult<{ approved: boolean }>("s1");
    now = 2_000;
    store.complete("s1", { approved: true });
    const result = await waiting;

    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ approved: true });
    expect(result.updatedAt).toBe("1970-01-01T00:00:02.000Z");
    expect(result.expiresAt).toBe("1970-01-01T00:01:02.000Z");
    expect(store.activeCount()).toBe(0);
    expect(store.list()).toEqual([]);
    expect(disposed).toBe(true);
    expect(store.get("s1")?.htmlContent).toBe("<html></html>");
    expect(store.get("s1")?.handleRequest).toBeDefined();
    expect(store.get("s1")?.dispose).toBeUndefined();
  });

  test("failed sessions dispose resources while retaining result delivery payloads", async () => {
    const store = new DaemonSessionStore({ idFactory: () => "s1", now: () => 1_000 });
    let disposed = false;
    store.create({
      mode: "review",
      url: "http://x/s/s1",
      project: "repo",
      label: "review",
      htmlContent: "<html></html>",
      handleRequest: () => new Response("ok"),
      dispose: () => { disposed = true; },
    });
    const waiting = store.waitForResult("s1");
    store.fail("s1", "Boom.");
    const result = await waiting;

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Boom.");
    expect(disposed).toBe(true);
    expect(store.get("s1")?.htmlContent).toBe("<html></html>");
    expect(store.get("s1")?.handleRequest).toBeDefined();
  });

  test("waiters resolve when a session is cancelled", async () => {
    const store = new DaemonSessionStore({ idFactory: () => "s1" });
    let disposed = false;
    store.create({
      mode: "annotate",
      url: "http://x/s/s1",
      project: "repo",
      label: "annotate",
      handleRequest: () => new Response("ok"),
      dispose: () => { disposed = true; },
    });
    const waiting = store.waitForResult("s1");
    await store.cancel("s1", "User cancelled.");
    const result = await waiting;

    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("User cancelled.");
    expect(disposed).toBe(true);
    expect(store.get("s1")?.handleRequest).toBeUndefined();
  });

  test("cleanupExpired marks active expired sessions and disposes them", async () => {
    const store = new DaemonSessionStore({ idFactory: () => "s1", now: () => 1_000 });
    let disposed = false;
    store.create({
      mode: "archive",
      url: "http://x/s/s1",
      project: "repo",
      label: "archive",
      ttlMs: 100,
      dispose: () => { disposed = true; },
    });
    const waiting = store.waitForResult("s1");
    const expired = await store.cleanupExpired(1_101);
    const result = await waiting;

    expect(expired).toHaveLength(1);
    expect(result.status).toBe("expired");
    expect(disposed).toBe(true);
    expect(store.get("s1")).toBeUndefined();
  });

  test("cleanupExpired removes terminal sessions after their TTL", async () => {
    const store = new DaemonSessionStore({ idFactory: () => "s1", now: () => 1_000 });
    store.create({
      mode: "plan",
      url: "http://x/s/s1",
      project: "repo",
      label: "plan",
      ttlMs: 100,
    });
    store.complete("s1", { approved: true });

    const expired = await store.cleanupExpired(61_001);

    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe("completed");
    expect(store.get("s1")).toBeUndefined();
  });

  test("delete rejects waiters and disposes", async () => {
    const store = new DaemonSessionStore({ idFactory: () => "s1" });
    let disposed = false;
    store.create({
      mode: "plan",
      url: "http://x/s/s1",
      project: "repo",
      label: "plan",
      dispose: () => { disposed = true; },
    });
    const waiting = store.waitForResult("s1");
    await store.delete("s1");

    await expect(waiting).rejects.toThrow("Session deleted: s1");
    expect(disposed).toBe(true);
    expect(store.get("s1")).toBeUndefined();
  });
});
