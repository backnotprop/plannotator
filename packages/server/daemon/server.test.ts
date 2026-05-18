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

async function readSseMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  const [message] = text.split("\n\n");
  return `${message}\n\n`;
}

function parseSseMessage(message: string): { event: string; data: Record<string, unknown> } {
  const event = message.match(/^event: (.+)$/m)?.[1] ?? "";
  const data = message.match(/^data: (.+)$/m)?.[1] ?? "{}";
  return { event, data: JSON.parse(data) as Record<string, unknown> };
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

  test("streams daemon snapshot and session lifecycle events", async () => {
    const { handler, store } = makeHandler();
    let timeoutDisabled = 0;
    const streamResponse = await handler(
      new Request("http://127.0.0.1:4321/daemon/events", { headers: authHeaders() }),
      { disableIdleTimeout: () => { timeoutDisabled += 1; } },
    );
    expect(timeoutDisabled).toBe(1);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    const reader = streamResponse.body!.getReader();

    const snapshot = parseSseMessage(await readSseMessage(reader));
    expect(snapshot.event).toBe("snapshot");
    expect(snapshot.data.type).toBe("snapshot");
    expect((snapshot.data.sessions as unknown[])).toHaveLength(0);

    const status = parseSseMessage(await readSseMessage(reader));
    expect(status.event).toBe("daemon-status");
    expect((status.data.status as { activeSessionCount: number }).activeSessionCount).toBe(0);

    await handler(new Request("http://127.0.0.1:4321/daemon/sessions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ request: { action: "plan", origin: "opencode", plan: "x" } }),
    }));
    const created = parseSseMessage(await readSseMessage(reader));
    expect(created.event).toBe("session-created");
    expect((created.data.session as { id: string; status: string }).id).toBe("s1");
    expect((created.data.session as { id: string; status: string }).status).toBe("active");

    store.complete("s1", { approved: true });
    const updated = parseSseMessage(await readSseMessage(reader));
    expect(updated.event).toBe("session-updated");
    expect((updated.data.session as { status: string }).status).toBe("completed");

    await store.delete("s1");
    const removed = parseSseMessage(await readSseMessage(reader));
    expect(removed.event).toBe("session-removed");
    expect((removed.data.session as { id: string }).id).toBe("s1");

    await reader.cancel();
  });

  test("broadcasts posted debug log events", async () => {
    const { handler } = makeHandler();
    const streamResponse = await handler(new Request("http://127.0.0.1:4321/daemon/events", { headers: authHeaders() }));
    const reader = streamResponse.body!.getReader();
    await readSseMessage(reader);
    await readSseMessage(reader);

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

    const debug = parseSseMessage(await readSseMessage(reader));
    expect(debug.event).toBe("debug-log");
    expect(debug.data.type).toBe("debug-log");
    expect(debug.data.source).toBe("agent-simulator");
    expect(debug.data.message).toBe("queued claude-plan-hook");

    await reader.cancel();
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
    expect(html).toContain("window.EventSource");
    expect(html).toContain("input instanceof Request");
    expect(html).toContain("window.EventSource.OPEN = OriginalEventSource.OPEN");
    expect(html.indexOf("window.__PLANNOTATOR_API_BASE__")).toBeGreaterThan(html.indexOf("shellLiteral"));
    expect(html.indexOf("window.__PLANNOTATOR_API_BASE__")).toBeLessThan(html.indexOf("<body>"));
  });

  test.each(["plan", "review", "annotate", "archive", "setup-goal"] as const)(
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
    expect(body.supportedSessionViews).toContain("setup-goal");
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
