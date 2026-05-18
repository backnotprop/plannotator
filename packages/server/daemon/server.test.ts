import { describe, expect, test } from "bun:test";
import { PLANNOTATOR_DAEMON_PROTOCOL, PLANNOTATOR_DAEMON_PROTOCOL_VERSION } from "@plannotator/shared/daemon-protocol";
import { createDaemonState } from "./state";
import { DaemonSessionStore } from "./session-store";
import { createDaemonFetchHandler } from "./server";

function makeHandler() {
  const store = new DaemonSessionStore({ idFactory: () => "s1", now: () => 1_000 });
  const state = createDaemonState({
    pid: 123,
    port: 4321,
    hostname: "127.0.0.1",
    isRemote: false,
    remoteSource: "local",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const handler = createDaemonFetchHandler({
    state,
    store,
    createSession: () => store.create({
      id: "s1",
      mode: "plan",
      url: `${state.baseUrl}/s/s1`,
      project: "repo",
      label: "plan-repo",
      htmlContent: "<html><script>const literal='</head>';</script><head></head><body>Plan</body></html>",
      handleRequest: (_req, url) => Response.json({ path: url.pathname }),
    }),
  });
  return { handler, store };
}

describe("daemon HTTP router", () => {
  test("serves public capabilities", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://127.0.0.1:4321/daemon/capabilities"));
    const body = await res.json();
    expect(body.protocol).toBe(PLANNOTATOR_DAEMON_PROTOCOL);
    expect(body.protocolVersion).toBe(PLANNOTATOR_DAEMON_PROTOCOL_VERSION);
    expect(body.multiSession).toBe(true);
  });

  test("serves the favicon at the daemon root", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://127.0.0.1:4321/favicon.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });

  test("reports daemon status with active session count", async () => {
    const { handler, store } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const res = await handler(new Request("http://127.0.0.1:4321/daemon/status"));
    const body = await res.json();
    expect(body.pid).toBe(123);
    expect(body.endpoint.baseUrl).toBe("http://localhost:4321");
    expect(body.activeSessionCount).toBe(1);
    expect(body.sessionCount).toBe(1);
    store.complete("s1", { approved: true });
    const afterComplete = await handler(new Request("http://127.0.0.1:4321/daemon/status"));
    const afterCompleteBody = await afterComplete.json();
    expect(afterCompleteBody.activeSessionCount).toBe(0);
    expect(afterCompleteBody.sessionCount).toBe(1);
  });

  test("creates and lists sessions", async () => {
    const { handler } = makeHandler();
    const create = await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.session.id).toBe("s1");

    const list = await handler(new Request("http://127.0.0.1:4321/daemon/sessions"));
    const body = await list.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].url).toBe("http://localhost:4321/s/s1");
  });

  test("disables idle timeout while creating sessions", async () => {
    const { handler } = makeHandler();
    let timeoutDisabled = 0;

    const create = await handler(
      new Request("http://127.0.0.1:4321/daemon/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
      }),
      { disableIdleTimeout: () => { timeoutDisabled += 1; } },
    );

    expect(create.status).toBe(201);
    expect(timeoutDisabled).toBe(1);
  });

  test("cleans expired sessions when requested by list route", async () => {
    let now = 1_000;
    const store = new DaemonSessionStore({ idFactory: () => "s1", now: () => now });
    const state = createDaemonState({
      pid: 123,
      port: 4321,
      hostname: "127.0.0.1",
      isRemote: false,
      remoteSource: "local",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const handler = createDaemonFetchHandler({
      state,
      store,
      createSession: () => store.create({
        id: "s1",
        mode: "plan",
        url: `${state.baseUrl}/s/s1`,
        project: "repo",
        label: "plan-repo",
        ttlMs: 100,
      }),
    });

    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    now = 1_101;
    const list = await handler(new Request("http://127.0.0.1:4321/daemon/sessions?clean=1"));
    const body = await list.json();

    expect(body.sessions).toHaveLength(0);
    expect(store.get("s1")).toBeUndefined();
  });

  test("serves session HTML with API base injection", async () => {
    const { handler } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const res = await handler(new Request("http://127.0.0.1:4321/s/s1"));
    const html = await res.text();
    expect(html).toContain("window.__PLANNOTATOR_API_BASE__ = apiBase");
    expect(html).toContain('apiBase = "/s/s1/api"');
    expect(html).toContain("window.fetch");
    expect(html).toContain("window.EventSource");
    expect(html).toContain("input instanceof Request");
    expect(html).toContain("window.EventSource.OPEN = OriginalEventSource.OPEN");
    expect(html.indexOf("window.__PLANNOTATOR_API_BASE__")).toBeGreaterThan(html.indexOf("const literal"));
    expect(html.indexOf("window.__PLANNOTATOR_API_BASE__")).toBeLessThan(html.indexOf("<body>"));
  });

  test("routes session-scoped API paths to the owning session", async () => {
    const { handler } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const res = await handler(new Request("http://127.0.0.1:4321/s/s1/api/plan"));
    const body = await res.json();
    expect(body.path).toBe("/api/plan");
  });

  test("does not route session paths that only prefix-match api", async () => {
    const { handler, store } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    let routed = 0;
    const record = store.get("s1");
    if (record) {
      record.handleRequest = () => {
        routed += 1;
        return Response.json({ routed: true });
      };
    }

    const res = await handler(new Request("http://127.0.0.1:4321/s/s1/api-docs"));
    const text = await res.text();

    expect(routed).toBe(0);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(text).toContain("Plan");
  });

  test("passes request context through session-scoped API paths", async () => {
    const { handler, store } = makeHandler();
    let timeoutDisabled = 0;
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const record = store.get("s1");
    if (record) {
      record.handleRequest = (_req, _url, context) => {
        context?.disableIdleTimeout?.();
        return Response.json({ ok: true });
      };
    }

    await handler(
      new Request("http://127.0.0.1:4321/s/s1/api/external-annotations/stream"),
      { disableIdleTimeout: () => { timeoutDisabled += 1; } },
    );

    expect(timeoutDisabled).toBe(1);
  });

  test("does not route root API paths by spoofable referer", async () => {
    const { handler } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const res = await handler(new Request("http://127.0.0.1:4321/api/plan", {
      headers: { referer: "http://127.0.0.1:4321/s/s1" },
    }));
    expect(res.status).toBe(404);
  });

  test("rejects non-JSON session creation requests", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const body = await res.json();
    expect(res.status).toBe(415);
    expect(body.error.code).toBe("invalid-request");
  });

  test("cancels sessions and returns result status", async () => {
    const { handler, store } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const cancel = await handler(new Request("http://127.0.0.1:4321/daemon/sessions/s1/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect((await cancel.json()).session.status).toBe("cancelled");

    const result = await handler(new Request("http://127.0.0.1:4321/daemon/sessions/s1/result"));
    const body = await result.json();
    expect(body.session.status).toBe("cancelled");
    expect(body.session.error).toBe("Session cancelled.");
    expect(store.get("s1")).toBeDefined();
  });

  test("disables idle timeout while waiting for session results", async () => {
    const { handler, store } = makeHandler();
    let timeoutDisabled = 0;
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));

    const resultPromise = handler(
      new Request("http://127.0.0.1:4321/daemon/sessions/s1/result"),
      { disableIdleTimeout: () => { timeoutDisabled += 1; } },
    );
    store.complete("s1", { approved: true });
    const body = await (await resultPromise).json();

    expect(timeoutDisabled).toBe(1);
    expect(body.result.approved).toBe(true);
  });

  test("rejects simple POST control requests without JSON content type", async () => {
    const { handler } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));

    const cancel = await handler(new Request("http://127.0.0.1:4321/daemon/sessions/s1/cancel", {
      method: "POST",
    }));
    const shutdown = await handler(new Request("http://127.0.0.1:4321/daemon/shutdown", {
      method: "POST",
    }));

    expect(cancel.status).toBe(415);
    expect((await cancel.json()).error.code).toBe("invalid-request");
    expect(shutdown.status).toBe(415);
    expect((await shutdown.json()).error.code).toBe("invalid-request");
  });
});
