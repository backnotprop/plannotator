import { describe, expect, test } from "bun:test";
import { PLANNOTATOR_DAEMON_PROTOCOL, PLANNOTATOR_DAEMON_PROTOCOL_VERSION } from "@plannotator/shared/daemon-protocol";
import { createDaemonState } from "./state";
import { DaemonSessionStore } from "./session-store";
import { createDaemonFetchHandler } from "./server";

const shellHtml = "<html><script>const shellLiteral='</head>';</script><head></head><body>Shell</body></html>";
const legacyPlanHtml = "<html><head></head><body>Plan</body></html>";
const AUTH_TOKEN = "test-auth-token-test-auth-token-1234";

function authHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  next.set("authorization", `Bearer ${AUTH_TOKEN}`);
  return next;
}

class FakeSocket {
  data?: { daemonAuthenticated?: boolean } = { daemonAuthenticated: true };
  sent: Record<string, unknown>[] = [];
  closed = false;

  send(message: string): void {
    this.sent.push(JSON.parse(message) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }
}

function makeHandler() {
  const store = new DaemonSessionStore({ idFactory: () => "s1", now: () => 1_000 });
  const state = createDaemonState({
    pid: 123,
    port: 4321,
    hostname: "127.0.0.1",
    isRemote: false,
    remoteSource: "local",
    authToken: AUTH_TOKEN,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const handler = createDaemonFetchHandler({
    state,
    shellHtmlContent: shellHtml,
    store,
    createSession: () => store.create({
      id: "s1",
      mode: "plan",
      url: `${state.baseUrl}/s/s1`,
      project: "repo",
      label: "plan-repo",
      htmlContent: legacyPlanHtml,
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

  test("serves the frontend shell at the daemon root", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://127.0.0.1:4321/"));
    const text = await res.text();

    expect(res.headers.get("content-type")).toContain("text/html");
    expect(text).toContain("Shell");
    expect(text).not.toContain("Plan");
    expect(text).not.toContain("__PLANNOTATOR_API_BASE__");
  });

  test("bootstraps browser daemon auth through a cookie", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request(`http://127.0.0.1:4321/?plannotator_auth=${AUTH_TOKEN}`));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:4321/");
    expect(res.headers.get("set-cookie")).toContain("plannotator_daemon_auth=");

    const sessionRes = await handler(new Request(`http://127.0.0.1:4321/s/test-session?plannotator_auth=${AUTH_TOKEN}`));
    expect(sessionRes.status).toBe(302);
    expect(sessionRes.headers.get("location")).toBe("http://127.0.0.1:4321/s/test-session");
    expect(sessionRes.headers.get("set-cookie")).toContain("plannotator_daemon_auth=");

    const status = await handler(new Request("http://127.0.0.1:4321/daemon/status", {
      headers: { cookie: `plannotator_daemon_auth=${AUTH_TOKEN}` },
    }));
    expect(status.status).toBe(200);

    const apiWithQueryToken = await handler(new Request(`http://127.0.0.1:4321/daemon/status?plannotator_auth=${AUTH_TOKEN}`));
    expect(apiWithQueryToken.status).toBe(401);
    expect(apiWithQueryToken.headers.get("set-cookie")).toBeNull();
  });

  test("rejects unauthenticated daemon control requests", async () => {
    const { handler } = makeHandler();
    const status = await handler(new Request("http://127.0.0.1:4321/daemon/status"));
    const create = await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));

    expect(status.status).toBe(401);
    expect((await status.json()).error.code).toBe("unauthorized");
    expect(create.status).toBe(401);
    expect((await create.json()).error.code).toBe("unauthorized");
  });

  test("authenticates daemon WebSocket upgrades", async () => {
    const { handler } = makeHandler();
    const upgradeData: unknown[] = [];

    const unauthenticated = await handler(
      new Request("http://127.0.0.1:4321/daemon/ws"),
      {
        upgradeWebSocket: (data) => {
          upgradeData.push(data);
          return undefined;
        },
      },
    );
    expect(unauthenticated).toBeUndefined();

    const authenticated = await handler(
      new Request("http://127.0.0.1:4321/daemon/ws", {
        headers: authHeaders({ origin: "http://127.0.0.1:4321" }),
      }),
      {
        upgradeWebSocket: (data) => {
          upgradeData.push(data);
          return undefined;
        },
      },
    );
    expect(authenticated).toBeUndefined();

    const queryAuthenticated = await handler(
      new Request(`http://127.0.0.1:4321/daemon/ws?plannotator_auth=${AUTH_TOKEN}`, {
        headers: { origin: "http://127.0.0.1:4321" },
      }),
      {
        upgradeWebSocket: (data) => {
          upgradeData.push(data);
          return undefined;
        },
      },
    );
    expect(queryAuthenticated).toBeUndefined();

    const crossOrigin = await handler(
      new Request("http://127.0.0.1:4321/daemon/ws", {
        headers: { origin: "http://evil.example" },
      }),
      {
        upgradeWebSocket: (data) => {
          upgradeData.push(data);
          return undefined;
        },
      },
    );
    expect(crossOrigin?.status).toBe(403);

    expect(upgradeData).toEqual([
      { daemonAuthenticated: false },
      { daemonAuthenticated: true },
      { daemonAuthenticated: true },
    ]);
  });

  test("reports daemon status with active session count", async () => {
    const { handler, store } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const res = await handler(new Request("http://127.0.0.1:4321/daemon/status", { headers: authHeaders() }));
    const body = await res.json();
    expect(body.pid).toBe(123);
    expect(body.endpoint.baseUrl).toBe("http://localhost:4321");
    expect(body.activeSessionCount).toBe(1);
    expect(body.sessionCount).toBe(1);
    store.complete("s1", { approved: true });
    const afterComplete = await handler(new Request("http://127.0.0.1:4321/daemon/status", { headers: authHeaders() }));
    const afterCompleteBody = await afterComplete.json();
    expect(afterCompleteBody.activeSessionCount).toBe(0);
    expect(afterCompleteBody.sessionCount).toBe(1);
  });

  test("publishes daemon snapshot and session lifecycle events over WebSocket", async () => {
    const { handler, store } = makeHandler();
    const socket = new FakeSocket();
    handler.websocket.open?.(socket as never);
    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "subscribe",
      scopes: [{ family: "daemon" }],
    }));

    const snapshot = socket.sent[0];
    expect(snapshot.type).toBe("snapshot");
    expect((snapshot.scope as { family: string }).family).toBe("daemon");
    expect(((snapshot.payload as { sessions: unknown[] }).sessions)).toHaveLength(0);

    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const created = socket.sent[1];
    expect(created.type).toBe("event");
    expect((created.payload as { type: string }).type).toBe("session-created");
    expect(((created.payload as { session: { id: string; status: string } }).session).id).toBe("s1");
    expect(((created.payload as { session: { id: string; status: string } }).session).status).toBe("active");

    store.complete("s1", { approved: true });
    const updated = socket.sent[2];
    expect((updated.payload as { type: string }).type).toBe("session-updated");
    expect(((updated.payload as { session: { status: string } }).session).status).toBe("completed");

    await store.delete("s1");
    const removed = socket.sent[3];
    expect((removed.payload as { type: string }).type).toBe("session-removed");
    expect(((removed.payload as { session: { id: string } }).session).id).toBe("s1");
    handler.websocket.close?.(socket as never, 1000, "");
    expect(socket.closed).toBe(false);
  });

  test("broadcasts posted debug log events", async () => {
    const { handler } = makeHandler();
    const socket = new FakeSocket();
    handler.websocket.open?.(socket as never);
    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "subscribe",
      scopes: [{ family: "daemon" }],
    }));

    const post = await handler(new Request("http://127.0.0.1:4321/daemon/events/debug", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        source: "agent-simulator",
        scenarioId: "claude-plan-hook",
        message: "queued claude-plan-hook",
      }),
    }));
    expect(post.status).toBe(200);

    const debug = socket.sent[1];
    expect(debug.type).toBe("event");
    expect((debug.payload as { type: string }).type).toBe("debug-log");
    expect((debug.payload as { source: string }).source).toBe("agent-simulator");
    expect((debug.payload as { message: string }).message).toBe("queued claude-plan-hook");
  });

  test("filters session-scoped WebSocket events by family and session", async () => {
    let sessionIndex = 0;
    const store = new DaemonSessionStore({ now: () => 1_000 });
    const state = createDaemonState({
      pid: 123,
      port: 4321,
      hostname: "127.0.0.1",
      isRemote: false,
      remoteSource: "local",
      authToken: AUTH_TOKEN,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const handler = createDaemonFetchHandler({
      state,
      shellHtmlContent: shellHtml,
      store,
      createSession: (_request, context) => {
        sessionIndex += 1;
        const id = `s${sessionIndex}`;
        const record = store.create({
          id,
          mode: "review",
          url: `${state.baseUrl}/s/${id}`,
          project: "repo",
          label: `review-${id}`,
        });
        context.registerSessionSnapshotProvider(id, "external-annotations", () => ({
          type: "snapshot",
          annotations: [{ id: `${id}-annotation` }],
        }));
        return record;
      },
    });

    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "review", origin: "opencode", rawPatch: "diff" } }),
    }));
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "review", origin: "opencode", rawPatch: "diff" } }),
    }));

    const s1Socket = new FakeSocket();
    const s2Socket = new FakeSocket();
    handler.websocket.open?.(s1Socket as never);
    handler.websocket.open?.(s2Socket as never);

    await handler.websocket.message?.(s1Socket as never, JSON.stringify({
      type: "subscribe",
      scopes: [{ family: "external-annotations", sessionId: "s1" }],
    }));
    await handler.websocket.message?.(s2Socket as never, JSON.stringify({
      type: "subscribe",
      scopes: [{ family: "external-annotations", sessionId: "s2" }],
    }));

    expect(s1Socket.sent[0].type).toBe("snapshot");
    expect((s1Socket.sent[0].scope as { sessionId: string }).sessionId).toBe("s1");
    expect((((s1Socket.sent[0].payload as { annotations: { id: string }[] }).annotations)[0]).id).toBe("s1-annotation");
    expect((s2Socket.sent[0].scope as { sessionId: string }).sessionId).toBe("s2");

    handler.eventHub.publishSessionEvent("s1", "external-annotations", {
      type: "added",
      annotation: { id: "s1-live" },
    });
    handler.eventHub.publishSessionEvent("s1", "agent-jobs", {
      type: "job-started",
      job: { id: "ignored" },
    });

    expect(s1Socket.sent).toHaveLength(2);
    expect((s1Socket.sent[1].payload as { type: string }).type).toBe("added");
    expect(s2Socket.sent).toHaveLength(1);

    await handler.websocket.message?.(s1Socket as never, JSON.stringify({
      type: "unsubscribe",
      scopes: [{ family: "external-annotations", sessionId: "s1" }],
    }));
    handler.eventHub.publishSessionEvent("s1", "external-annotations", {
      type: "added",
      annotation: { id: "after-unsubscribe" },
    });
    expect(s1Socket.sent).toHaveLength(2);
  });

  test("allows unauthenticated WebSocket clients to subscribe only to session scopes", async () => {
    const { handler } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));

    const socket = new FakeSocket();
    socket.data = { daemonAuthenticated: false };
    handler.websocket.open?.(socket as never);

    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "subscribe",
      requestId: "daemon-sub",
      scopes: [{ family: "daemon" }],
    }));
    expect(socket.sent[0]).toMatchObject({
      type: "error",
      requestId: "daemon-sub",
      code: "unauthorized",
    });

    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "subscribe",
      requestId: "session-sub",
      scopes: [{ family: "external-annotations", sessionId: "s1" }],
    }));
    expect(socket.sent[1]).toMatchObject({
      type: "error",
      requestId: "session-sub",
      code: "session-not-found",
    });
  });

  test("treats missing WebSocket auth metadata as unauthenticated", async () => {
    const { handler } = makeHandler();
    const socket = new FakeSocket();
    socket.data = undefined;
    handler.websocket.open?.(socket as never);

    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "subscribe",
      requestId: "daemon-sub",
      scopes: [{ family: "daemon" }],
    }));

    expect(socket.sent[0]).toMatchObject({
      type: "error",
      requestId: "daemon-sub",
      code: "unauthorized",
    });
  });

  test("removes failed subscriptions when a session snapshot cannot be created", async () => {
    const { handler } = makeHandler();
    const socket = new FakeSocket();
    handler.websocket.open?.(socket as never);

    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "subscribe",
      requestId: "sub-1",
      scopes: [{ family: "external-annotations", sessionId: "missing-session" }],
    }));

    expect(socket.sent[0]).toMatchObject({
      type: "error",
      requestId: "sub-1",
      code: "session-not-found",
    });

    handler.eventHub.publishSessionEvent("missing-session", "external-annotations", {
      type: "add",
      annotations: [{ id: "late-event" }],
    });
    expect(socket.sent).toHaveLength(1);
  });

  test("sends subscription snapshots before events published during snapshot creation", async () => {
    let resolveSnapshot: ((payload: unknown) => void) | undefined;
    let publishAgentEvent: ((event: unknown) => void) | undefined;
    const store = new DaemonSessionStore({ now: () => 1_000 });
    const state = createDaemonState({
      pid: 123,
      port: 4321,
      hostname: "127.0.0.1",
      isRemote: false,
      remoteSource: "local",
      authToken: AUTH_TOKEN,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const handler = createDaemonFetchHandler({
      state,
      shellHtmlContent: shellHtml,
      store,
      createSession: (_request, context) => {
        const record = store.create({
          id: "s1",
          mode: "review",
          url: `${state.baseUrl}/s/s1`,
          project: "repo",
          label: "review-s1",
        });
        context.registerSessionSnapshotProvider("s1", "agent-jobs", () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          }));
        publishAgentEvent = (event) => {
          context.publishSessionEvent("s1", "agent-jobs", event);
        };
        return record;
      },
    });

    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "review", origin: "opencode", rawPatch: "diff" } }),
    }));

    const socket = new FakeSocket();
    handler.websocket.open?.(socket as never);
    const subscribe = handler.websocket.message?.(socket as never, JSON.stringify({
      type: "subscribe",
      scopes: [{ family: "agent-jobs", sessionId: "s1" }],
    }));

    expect(socket.sent).toHaveLength(0);
    publishAgentEvent?.({
      type: "job:completed",
      job: { id: "job-1", status: "done" },
    });
    expect(socket.sent).toHaveLength(0);

    resolveSnapshot?.({ type: "snapshot", jobs: [], logs: {} });
    await subscribe;

    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0].type).toBe("snapshot");
    expect(socket.sent[1].type).toBe("event");
    expect(socket.sent[1].payload).toEqual({
      type: "job:completed",
      job: { id: "job-1", status: "done" },
    });
  });

  test("returns correlated WebSocket action replies for session API commands", async () => {
    const { handler, store } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const record = store.get("s1");
    if (record) {
      record.handleRequest = async (req, url) => {
        return Response.json({
          method: req.method,
          path: url.pathname,
          body: await req.json(),
        }, { status: 202 });
      };
    }

    const socket = new FakeSocket();
    handler.websocket.open?.(socket as never);
    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "action",
      requestId: "req-1",
      sessionId: "s1",
      method: "POST",
      path: "/api/approve",
      body: { approved: true },
    }));

    expect(socket.sent[0]).toMatchObject({
      type: "action-result",
      requestId: "req-1",
      ok: true,
      status: 202,
    });
    expect(socket.sent[0].payload).toEqual({
      method: "POST",
      path: "/api/approve",
      body: { approved: true },
    });
  });

  test("rejects WebSocket session actions after URL path normalization", async () => {
    const { handler, store } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    let handled = false;
    const record = store.get("s1");
    if (record) {
      record.handleRequest = async () => {
        handled = true;
        return Response.json({ ok: true });
      };
    }

    const socket = new FakeSocket();
    handler.websocket.open?.(socket as never);
    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "action",
      requestId: "req-traversal",
      sessionId: "s1",
      method: "POST",
      path: "/api/../daemon/shutdown",
    }));

    expect(handled).toBe(false);
    expect(socket.sent[0]).toMatchObject({
      type: "error",
      requestId: "req-traversal",
      code: "internal-error",
    });
  });

  test("cleans WebSocket subscriptions when a connection closes", async () => {
    const { handler } = makeHandler();
    const socket = new FakeSocket();
    handler.websocket.open?.(socket as never);
    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "subscribe",
      scopes: [{ family: "daemon" }],
    }));

    expect(handler.eventHub.connectionCount).toBe(1);
    handler.websocket.close?.(socket as never, 1000, "");
    expect(handler.eventHub.connectionCount).toBe(0);

    handler.eventHub.publishDaemonEvent({
      type: "debug-log",
      at: "2026-01-01T00:00:00.000Z",
      source: "test",
      message: "after close",
    });
    expect(socket.sent).toHaveLength(1);
  });

  test("responds to WebSocket pings", async () => {
    const { handler } = makeHandler();
    const socket = new FakeSocket();
    handler.websocket.open?.(socket as never);
    await handler.websocket.message?.(socket as never, JSON.stringify({
      type: "ping",
      requestId: "ping-1",
    }));

    expect(socket.sent[0]).toMatchObject({
      type: "pong",
      requestId: "ping-1",
    });
  });

  test("rejects old daemon SSE route", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://127.0.0.1:4321/daemon/events", { headers: authHeaders() }));
    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
  });

  test("creates and lists sessions", async () => {
    const { handler } = makeHandler();
    const create = await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.session.id).toBe("s1");

    const list = await handler(new Request("http://127.0.0.1:4321/daemon/sessions", { headers: authHeaders() }));
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
        headers: authHeaders({ "content-type": "application/json" }),
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
      authToken: AUTH_TOKEN,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const handler = createDaemonFetchHandler({
      state,
      shellHtmlContent: shellHtml,
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
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    now = 1_101;
    const list = await handler(new Request("http://127.0.0.1:4321/daemon/sessions?clean=1", { headers: authHeaders() }));
    const body = await list.json();

    expect(body.sessions).toHaveLength(0);
    expect(store.get("s1")).toBeUndefined();
  });

  test("serves session shell HTML with API base injection", async () => {
    const { handler } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const res = await handler(new Request("http://127.0.0.1:4321/s/s1"));
    const html = await res.text();
    expect(html).toContain("window.__PLANNOTATOR_API_BASE__ = apiBase");
    expect(html).toContain('apiBase = "/s/s1/api"');
    expect(html).toContain("Shell");
    expect(html).not.toContain("Plan");
    expect(html).toContain("window.fetch");
    expect(html).toContain("input instanceof Request");
    expect(html).not.toContain("window.EventSource");
    expect(html.indexOf("window.__PLANNOTATOR_API_BASE__")).toBeGreaterThan(html.indexOf("shellLiteral"));
    expect(html.indexOf("window.__PLANNOTATOR_API_BASE__")).toBeLessThan(html.indexOf("<body>"));
  });

  test.each(["plan", "review", "annotate", "archive", "goal-setup"] as const)(
    "serves the same frontend shell for %s session pages",
    async (mode) => {
      const store = new DaemonSessionStore({ now: () => 1_000 });
      const state = createDaemonState({
        pid: 123,
        port: 4321,
        hostname: "127.0.0.1",
        isRemote: false,
        remoteSource: "local",
        authToken: AUTH_TOKEN,
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      store.create({
        id: mode,
        mode,
        url: `${state.baseUrl}/s/${mode}`,
        project: "repo",
        label: `${mode}-repo`,
        htmlContent: `<html><head></head><body>Legacy ${mode}</body></html>`,
      });
      const handler = createDaemonFetchHandler({
        state,
        shellHtmlContent: shellHtml,
        store,
        createSession: () => {
          throw new Error("not used");
        },
      });

      const res = await handler(new Request(`http://127.0.0.1:4321/s/${mode}`));
      const text = await res.text();

      expect(text).toContain("Shell");
      expect(text).toContain(`apiBase = "/s/${mode}/api"`);
      expect(text).not.toContain(`Legacy ${mode}`);
    },
  );

  test("routes session-scoped API paths to the owning session", async () => {
    const { handler } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const res = await handler(new Request("http://127.0.0.1:4321/s/s1/api/plan"));
    const body = await res.json();
    expect(body.path).toBe("/api/plan");
  });

  test("serves session bootstrap before delegating to the session handler", async () => {
    const { handler, store } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
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

    const res = await handler(new Request("http://127.0.0.1:4321/s/s1/api/session"));
    const body = await res.json();

    expect(routed).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.session.id).toBe("s1");
    expect(body.session.mode).toBe("plan");
    expect(body.apiBase).toBe("/s/s1/api");
    expect(body.capabilities.protocol).toBe(PLANNOTATOR_DAEMON_PROTOCOL);
    expect(body.supportedSessionViews).toContain("plan");
    expect(body.supportedSessionViews).toContain("goal-setup");
  });

  test("returns a daemon error for missing session bootstrap", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://127.0.0.1:4321/s/missing/api/session"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("session-not-found");
  });

  test("serves shell HTML for missing session page routes", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://127.0.0.1:4321/s/missing"));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(text).toContain("Shell");
    expect(text).toContain('apiBase = "/s/missing/api"');
  });

  test("does not serve shell HTML for non-page session requests", async () => {
    const { handler } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));

    const existing = await handler(new Request("http://127.0.0.1:4321/s/s1/not-api", {
      method: "POST",
      body: "{}",
    }));
    const missing = await handler(new Request("http://127.0.0.1:4321/s/missing", {
      method: "POST",
      body: "{}",
    }));

    expect(existing.status).toBe(404);
    expect(await existing.text()).not.toContain("Shell");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("Shell");
  });

  test("returns daemon errors for missing session API routes", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://127.0.0.1:4321/s/missing/api/plan"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("session-not-found");
  });

  test("does not route session paths that only prefix-match api", async () => {
    const { handler, store } = makeHandler();
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
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
    expect(text).toContain("Shell");
    expect(text).not.toContain("Plan");
  });

  test("passes request context through session-scoped API paths", async () => {
    const { handler, store } = makeHandler();
    let timeoutDisabled = 0;
    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
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
      headers: authHeaders({ "content-type": "application/json" }),
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
      headers: authHeaders({ "content-type": "text/plain" }),
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
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const cancel = await handler(new Request("http://127.0.0.1:4321/daemon/sessions/s1/cancel", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{}",
    }));
    expect((await cancel.json()).session.status).toBe("cancelled");

    const result = await handler(new Request("http://127.0.0.1:4321/daemon/sessions/s1/result", { headers: authHeaders() }));
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
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));

    const resultPromise = handler(
      new Request("http://127.0.0.1:4321/daemon/sessions/s1/result", { headers: authHeaders() }),
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
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));

    const cancel = await handler(new Request("http://127.0.0.1:4321/daemon/sessions/s1/cancel", {
      method: "POST",
      headers: authHeaders(),
    }));
    const shutdown = await handler(new Request("http://127.0.0.1:4321/daemon/shutdown", {
      method: "POST",
      headers: authHeaders(),
    }));

    expect(cancel.status).toBe(415);
    expect((await cancel.json()).error.code).toBe("invalid-request");
    expect(shutdown.status).toBe(415);
    expect((await shutdown.json()).error.code).toBe("invalid-request");
  });
});
