import { afterEach, describe, expect, test } from "bun:test";
import { createAIEndpoints } from "./endpoints.ts";
import { ProviderRegistry } from "./provider.ts";
import { SessionManager } from "./session-manager.ts";
import {
  SESSION_ASK_HEADER,
  SESSION_ASK_TRANSIENT_NOTE,
  SESSION_BRIDGE_ERROR,
  SESSION_BRIDGE_PROVIDER_NAME,
  SessionBridgeProvider,
  type SessionBridge,
  type SessionBridgeAskRequest,
  type SessionBridgeSink,
  type SessionBridgeStatus,
} from "./session-bridge.ts";
import {
  createPullSessionBridge,
  takePullSessionBridgeConfig,
  SESSION_BRIDGE_EVENT_PATH,
  SESSION_BRIDGE_POLL_PATH,
  type PullSessionBridgeOptions,
} from "./session-bridge-pull.ts";
import { runPullSessionBridgeClient } from "./session-bridge-pull-client.ts";
import type { AIContext, AIMessage } from "./types.ts";

const TOKEN = "t".repeat(43);
const HOST = "127.0.0.1:4321";
const CONTEXT: AIContext = { mode: "annotate", annotate: { content: "# Doc", filePath: "/repo/notes.md" } };

interface HostAsk {
  req: SessionBridgeAskRequest;
  sink: SessionBridgeSink;
  signal: AbortSignal;
}

/** The host side: an in-process bridge the test drives by hand. */
function fakeHost(initial: SessionBridgeStatus = "ready", modes = { turn: true, transient: false }) {
  let status = initial;
  const asks: HostAsk[] = [];
  let interrupts = 0;
  const bridge: SessionBridge = {
    host: "opencode",
    modes,
    status: () => status,
    ask(req, sink, signal) {
      asks.push({ req, sink, signal });
    },
    interrupt() {
      interrupts += 1;
      status = "ready";
    },
  };
  return {
    bridge,
    asks,
    get interrupts() {
      return interrupts;
    },
    setStatus(next: SessionBridgeStatus) {
      status = next;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collect(iterable: AsyncIterable<AIMessage>) {
  const messages: AIMessage[] = [];
  const done = (async () => {
    for await (const message of iterable) messages.push(message);
  })();
  return { messages, done };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A Plannotator server's AI runtime with a pull bridge, plus a host process
 * simulated by the real pull client talking to it through `fetch`.
 */
function setup(options: Partial<PullSessionBridgeOptions> = {}, host = fakeHost()) {
  const pull = createPullSessionBridge({
    token: TOKEN,
    host: "opencode",
    modes: host.bridge.modes,
    connectTimeoutMs: 2_000,
    goneAfterMs: 2_000,
    resendAfterMs: 50,
    ...options,
  });
  const registry = new ProviderRegistry();
  const provider = new SessionBridgeProvider(pull.bridge, { pollIntervalMs: 5 });
  registry.register(provider, SESSION_BRIDGE_PROVIDER_NAME);
  const endpoints = createAIEndpoints({
    registry,
    sessionManager: new SessionManager(),
    authorizeSessionBridgeRequest: (req) => req.headers.get("host") === HOST,
    pullBridge: pull,
  });
  const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    (endpoints as Record<string, (req: Request) => Promise<Response>>)[path](
      new Request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...(init.headers as Record<string, string>), ...headers } }),
    );
  const fetchShim = (async (url: string | URL | Request, init?: RequestInit) =>
    call(new URL(String(url)).pathname, init ?? {})) as typeof fetch;
  const controller = new AbortController();
  const startHost = (overrides: { token?: string } = {}) =>
    runPullSessionBridgeClient({
      baseUrl: `http://${HOST}`,
      token: overrides.token ?? TOKEN,
      bridge: host.bridge,
      signal: controller.signal,
      pollWaitMs: 100,
      statusIntervalMs: 10,
      deltaFlushMs: 5,
      maxFailures: 2,
      fetch: fetchShim,
    });
  cleanups.push(() => {
    controller.abort();
    pull.dispose();
  });
  return { pull, provider, host, call, startHost, stopHost: () => controller.abort() };
}

describe("pull session bridge", () => {
  test("a question reaches the host through the poll and the answer streams back", async () => {
    const { provider, host, startHost } = setup();
    void startHost();
    const session = await provider.createSession({ context: CONTEXT });
    const run = collect(session.query("Why this change?"));

    await waitFor(() => host.asks.length === 1);
    const ask = host.asks[0];
    expect(ask.req.mode).toBe("turn");
    expect(ask.req.text.startsWith(SESSION_ASK_HEADER)).toBe(true);
    expect(ask.req.text).toContain("Why this change?");

    ask.sink.delta("Because ");
    ask.sink.tool?.("read");
    ask.sink.delta("of #12.");
    ask.sink.done("Because of #12.");
    await run.done;

    const text = run.messages.filter((m) => m.type === "text_delta").map((m) => (m as { delta: string }).delta).join("");
    expect(text).toBe("Because of #12.");
    expect(run.messages.some((m) => m.type === "tool_use" && m.toolName === "read")).toBe(true);
    expect(run.messages.at(-1)).toMatchObject({ type: "result", success: true, result: "Because of #12." });
  });

  test("a question asked before the host connects waits for its first poll", async () => {
    const { provider, host, startHost } = setup();
    const session = await provider.createSession({ context: CONTEXT });
    const run = collect(session.query("early"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.asks.length).toBe(0);
    void startHost();
    await waitFor(() => host.asks.length === 1);
    host.asks[0].sink.done("ok");
    await run.done;
    expect(run.messages.at(-1)).toMatchObject({ type: "result", result: "ok" });
  });

  test("a busy host: no policy answers agent_busy, wait holds the question until the host is ready", async () => {
    const host = fakeHost("busy");
    const { provider, startHost, pull } = setup({}, host);
    void startHost();
    await waitFor(() => pull.bridge.status() === "busy");
    const session = await provider.createSession({ context: CONTEXT });

    const refused = collect(session.query("q"));
    await refused.done;
    expect(refused.messages).toEqual([expect.objectContaining({ type: "error", code: SESSION_BRIDGE_ERROR.agentBusy })]);

    const waiting = collect(session.query("q", { busyPolicy: "wait" }));
    await waitFor(() => waiting.messages.some((m) => m.type === "status"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.asks.length).toBe(0);
    host.setStatus("ready");
    await waitFor(() => host.asks.length === 1);
    host.asks[0].sink.done("answered");
    await waiting.done;
    expect(waiting.messages.map((m) => m.type)).toEqual(["status", "status", "result"]);
  });

  test("interrupt-and-ask runs the host's interrupt through the poll before the question", async () => {
    const host = fakeHost("busy");
    const { provider, startHost, pull } = setup({}, host);
    void startHost();
    await waitFor(() => pull.bridge.status() === "busy");
    const session = await provider.createSession({ context: CONTEXT });
    const run = collect(session.query("now", { busyPolicy: "interrupt" }));
    await waitFor(() => host.asks.length === 1);
    expect(host.interrupts).toBe(1);
    host.asks[0].sink.done("done");
    await run.done;
    expect(run.messages[0]).toEqual({ type: "status", status: "interrupting" });
    expect(run.messages.at(-1)).toMatchObject({ type: "result", result: "done" });
  });

  test("stopping a running question cancels it on the host, and frees the slot when the host confirms", async () => {
    const { provider, host, startHost, pull } = setup();
    void startHost();
    const session = await provider.createSession({ context: CONTEXT });
    const run = collect(session.query("long one"));
    await waitFor(() => host.asks.length === 1);
    host.asks[0].sink.delta("partial");
    await new Promise((resolve) => setTimeout(resolve, 20));

    session.abort();
    await run.done;
    await waitFor(() => host.asks[0].signal.aborted);

    // Still running on the host: a second question is refused until it ends.
    const second = await provider.createSession({ context: CONTEXT });
    const refused = collect(second.query("next"));
    await refused.done;
    expect(refused.messages.at(-1)).toMatchObject({ type: "error", code: SESSION_BRIDGE_ERROR.agentBusy });

    host.asks[0].sink.error("aborted");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const third = collect(second.query("next"));
    await waitFor(() => host.asks.length === 2);
    host.asks[1].sink.done("ok");
    await third.done;
    expect(third.messages.at(-1)).toMatchObject({ type: "result", result: "ok" });
    expect(pull.bridge.status()).toBe("ready");
  });

  test("a question stopped before the host picked it up never reaches the host", async () => {
    const { provider, host, startHost } = setup();
    const session = await provider.createSession({ context: CONTEXT });
    const run = collect(session.query("never"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.abort();
    await run.done;
    void startHost();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(host.asks.length).toBe(0);
  });

  test("a host that stops polling is gone: the running question fails with session_gone", async () => {
    const { provider, host, startHost, stopHost, pull } = setup({ goneAfterMs: 150 });
    void startHost();
    const session = await provider.createSession({ context: CONTEXT });
    const run = collect(session.query("q"));
    await waitFor(() => host.asks.length === 1);
    stopHost();
    await run.done;
    expect(run.messages.at(-1)).toMatchObject({ type: "error", code: SESSION_BRIDGE_ERROR.gone });
    expect(pull.bridge.status()).toBe("gone");
  });

  test("a host that never connects is gone after the connect timeout", async () => {
    const { pull } = setup({ connectTimeoutMs: 50 });
    expect(pull.bridge.status()).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(pull.bridge.status()).toBe("gone");
  });

  test("a blocked host with a transient mode gets a quick-answer question", async () => {
    const host = fakeHost("blocked", { turn: false, transient: true });
    const { provider, startHost, pull } = setup({}, host);
    expect(provider.label).toBe("Quick answer from this session · OpenCode");
    void startHost();
    await waitFor(() => pull.bridge.status() === "blocked");
    const session = await provider.createSession({ context: CONTEXT });
    const run = collect(session.query("what is step 2?"));
    await waitFor(() => host.asks.length === 1);
    expect(host.asks[0].req.mode).toBe("transient");
    expect(host.asks[0].req.text).toContain(SESSION_ASK_TRANSIENT_NOTE);
    host.asks[0].sink.done("Step 2 migrates the table.");
    await run.done;
    expect(run.messages.at(-1)).toMatchObject({ type: "result", result: "Step 2 migrates the table." });
  });

  test("refuses a wrong token, a browser Origin, a non-loopback Host, and answers 404 with no bridge", async () => {
    const { call } = setup();
    const poll = { method: "POST", body: JSON.stringify({ waitMs: 0 }) };
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await call(SESSION_BRIDGE_POLL_PATH, poll, auth)).status).toBe(200);
    expect((await call(SESSION_BRIDGE_POLL_PATH, poll, { authorization: `Bearer ${"x".repeat(43)}` })).status).toBe(401);
    expect((await call(SESSION_BRIDGE_POLL_PATH, poll)).status).toBe(401);
    expect((await call(SESSION_BRIDGE_EVENT_PATH, { method: "POST", body: "{}" }, { ...auth, origin: "http://localhost:4321" })).status).toBe(403);
    // DNS rebinding: right token, wrong Host.
    expect((await call(SESSION_BRIDGE_POLL_PATH, poll, { ...auth, host: "evil.example:4321" })).status).toBe(403);

    const bare = createAIEndpoints({ registry: new ProviderRegistry(), sessionManager: new SessionManager(), authorizeSessionBridgeRequest: () => true });
    const res = await bare[SESSION_BRIDGE_POLL_PATH](new Request(`http://${HOST}${SESSION_BRIDGE_POLL_PATH}`, { method: "POST", headers: auth, body: "{}" }));
    expect(res.status).toBe(404);
  });

  test("a newer poll supersedes an open one, and dispose answers the open poll with closing", async () => {
    const { call, pull } = setup();
    const auth = { authorization: `Bearer ${TOKEN}` };
    const first = call(SESSION_BRIDGE_POLL_PATH, { method: "POST", body: JSON.stringify({ waitMs: 5_000 }) }, auth);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = call(SESSION_BRIDGE_POLL_PATH, { method: "POST", body: JSON.stringify({ waitMs: 5_000 }) }, auth);
    expect(await (await first).json()).toEqual({ commands: [], superseded: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    pull.dispose();
    expect(await (await second).json()).toEqual({ commands: [], closing: true });
    expect(pull.bridge.status()).toBe("gone");
  });

  test("detach drops a question the host never picked up and leaves a running one alone", async () => {
    const { provider, host, startHost, pull } = setup();
    const session = await provider.createSession({ context: CONTEXT });
    const run = collect(session.query("pending"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    provider.detach();
    void startHost();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(host.asks.length).toBe(0);
    session.abort();
    await run.done;
    expect(pull.bridge.status()).not.toBe("gone");
  });
});

describe("takePullSessionBridgeConfig", () => {
  test("reads the host's config once and scrubs it from the environment", () => {
    const env: Record<string, string | undefined> = {
      PLANNOTATOR_SESSION_BRIDGE_TOKEN: TOKEN,
      PLANNOTATOR_SESSION_BRIDGE_HOST: "opencode",
      PLANNOTATOR_SESSION_BRIDGE_MODES: "turn,transient",
      OTHER: "kept",
    };
    expect(takePullSessionBridgeConfig(env)).toEqual({ token: TOKEN, host: "opencode", modes: { turn: true, transient: true } });
    expect(env).toEqual({ OTHER: "kept" });
    expect(takePullSessionBridgeConfig(env)).toBeUndefined();
  });

  test("refuses a short token or an unknown host", () => {
    expect(takePullSessionBridgeConfig({ PLANNOTATOR_SESSION_BRIDGE_TOKEN: "short", PLANNOTATOR_SESSION_BRIDGE_HOST: "opencode" })).toBeUndefined();
    expect(takePullSessionBridgeConfig({ PLANNOTATOR_SESSION_BRIDGE_TOKEN: TOKEN, PLANNOTATOR_SESSION_BRIDGE_HOST: "someone" })).toBeUndefined();
  });
});
