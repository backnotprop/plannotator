import { describe, expect, test } from "bun:test";
import { createAIEndpoints, SESSION_BRIDGE_FORBIDDEN_HOST, type AIEndpointDeps } from "./endpoints.ts";
import { ProviderRegistry } from "./provider.ts";
import { BaseSession } from "./base-session.ts";
import { SessionManager } from "./session-manager.ts";
import {
  SESSION_ASK_HEADER,
  SESSION_ASK_TAKEN_OVER_TEXT,
  SESSION_BRIDGE_ERROR,
  SESSION_BRIDGE_PROVIDER_NAME,
  SessionBridgeProvider,
  formatSessionAskText,
  type SessionBridge,
  type SessionBridgeAskRequest,
  type SessionBridgeSink,
  type SessionBridgeStatus,
} from "./session-bridge.ts";
import type { AIContext, AIMessage } from "./types.ts";

const CONTEXT: AIContext = {
  mode: "annotate",
  annotate: { content: "# Doc", filePath: "/repo/notes.md" },
};

interface PendingAsk {
  req: SessionBridgeAskRequest;
  sink: SessionBridgeSink;
  signal: AbortSignal;
}

/** A host bridge whose status and answers the test drives by hand. */
function fakeBridge(initial: SessionBridgeStatus = "ready", options: { interrupt?: boolean; transient?: boolean } = {}) {
  let status = initial;
  const asks: PendingAsk[] = [];
  const interrupts: number[] = [];
  const bridge: SessionBridge = {
    host: "pi",
    modes: { turn: true, transient: options.transient ?? false },
    status: () => status,
    ask(req, sink, signal) {
      asks.push({ req, sink, signal });
    },
    ...(options.interrupt !== false && {
      interrupt() {
        interrupts.push(Date.now());
      },
    }),
  };
  return {
    bridge,
    asks,
    interrupts,
    setStatus(next: SessionBridgeStatus) {
      status = next;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Drain a query into an array while the test drives the bridge. */
function collect(iterable: AsyncIterable<AIMessage>) {
  const messages: AIMessage[] = [];
  const done = (async () => {
    for await (const message of iterable) messages.push(message);
  })();
  return { messages, done };
}

async function newSession(provider: SessionBridgeProvider) {
  return provider.createSession({ context: CONTEXT });
}

describe("SessionBridgeProvider", () => {
  test("streams the session's answer and sends the question with the Plannotator header", async () => {
    const host = fakeBridge("ready");
    const provider = new SessionBridgeProvider(host.bridge, { pollIntervalMs: 5 });
    const session = await newSession(provider);

    const run = collect(session.query("Why is this list sorted?"));
    await waitFor(() => host.asks.length === 1);
    const { req, sink } = host.asks[0];
    expect(req.mode).toBe("turn");
    expect(req.text.startsWith(SESSION_ASK_HEADER)).toBe(true);
    expect(req.text).toContain("/repo/notes.md");
    expect(req.text.endsWith("Why is this list sorted?")).toBe(true);

    sink.delta("Because ");
    sink.tool?.("read");
    sink.delta("it is.");
    sink.done("Because it is.");
    await run.done;

    expect(run.messages.map((m) => m.type)).toEqual(["text_delta", "tool_use", "text_delta", "result"]);
    const result = run.messages.at(-1);
    expect(result?.type === "result" && result.result).toBe("Because it is.");
    expect(session.isActive).toBe(false);
  });

  test("a busy session answers agent_busy and never sends the question without a choice", async () => {
    const host = fakeBridge("busy");
    const provider = new SessionBridgeProvider(host.bridge, { pollIntervalMs: 5 });
    const session = await newSession(provider);

    const run = collect(session.query("q"));
    await run.done;

    expect(host.asks).toHaveLength(0);
    expect(host.interrupts).toHaveLength(0);
    expect(run.messages).toEqual([expect.objectContaining({ type: "error", code: SESSION_BRIDGE_ERROR.agentBusy })]);
  });

  test('"wait" holds the question until the session is idle, then sends it', async () => {
    const host = fakeBridge("busy");
    const provider = new SessionBridgeProvider(host.bridge, { pollIntervalMs: 5 });
    const session = await newSession(provider);

    const run = collect(session.query("q", { busyPolicy: "wait" }));
    await waitFor(() => run.messages.length === 1);
    expect(run.messages[0]).toEqual({ type: "status", status: "waiting" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.asks).toHaveLength(0);

    host.setStatus("ready");
    await waitFor(() => host.asks.length === 1);
    expect(host.interrupts).toHaveLength(0);
    host.asks[0].sink.done("ok");
    await run.done;
    expect(run.messages.map((m) => m.type)).toEqual(["status", "status", "result"]);
  });

  test('"interrupt" stops the session first, then asks once it is idle', async () => {
    const host = fakeBridge("busy");
    const provider = new SessionBridgeProvider(host.bridge, { pollIntervalMs: 5 });
    const session = await newSession(provider);

    const run = collect(session.query("q", { busyPolicy: "interrupt" }));
    await waitFor(() => host.interrupts.length === 1);
    expect(host.asks).toHaveLength(0);
    host.setStatus("ready");
    await waitFor(() => host.asks.length === 1);
    host.asks[0].sink.done("ok");
    await run.done;
    expect(run.messages[0]).toEqual({ type: "status", status: "interrupting" });
  });

  test("a host that cannot interrupt keeps asking the reviewer to choose", async () => {
    const host = fakeBridge("busy", { interrupt: false });
    const provider = new SessionBridgeProvider(host.bridge, { pollIntervalMs: 5 });
    const run = collect((await newSession(provider)).query("q", { busyPolicy: "interrupt" }));
    await run.done;
    expect(run.messages).toEqual([expect.objectContaining({ code: SESSION_BRIDGE_ERROR.agentBusy })]);
  });

  test("stopping a waiting question drops it without touching the session", async () => {
    const host = fakeBridge("busy");
    const provider = new SessionBridgeProvider(host.bridge, { pollIntervalMs: 5 });
    const session = await newSession(provider);

    const run = collect(session.query("q", { busyPolicy: "wait" }));
    await waitFor(() => run.messages.length === 1);
    session.abort();
    await run.done;
    host.setStatus("ready");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.asks).toHaveLength(0);
    expect(host.interrupts).toHaveLength(0);
  });

  test("stopping a running question aborts only the signal handed to the host for it", async () => {
    const host = fakeBridge("ready");
    const provider = new SessionBridgeProvider(host.bridge, { pollIntervalMs: 5 });
    const session = await newSession(provider);

    const run = collect(session.query("q"));
    await waitFor(() => host.asks.length === 1);
    host.asks[0].sink.delta("partial");
    session.abort();
    await run.done;
    expect(host.asks[0].signal.aborted).toBe(true);
    expect(host.interrupts).toHaveLength(0);
    // A late answer after the stop goes nowhere.
    host.asks[0].sink.done("late");
    expect(run.messages.some((m) => m.type === "result")).toBe(false);
  });

  test("after detach (decision / shutdown) an abort no longer reaches a running turn", async () => {
    const host = fakeBridge("ready");
    const provider = new SessionBridgeProvider(host.bridge, { pollIntervalMs: 5 });
    const session = await newSession(provider);

    const run = collect(session.query("q"));
    await waitFor(() => host.asks.length === 1);
    provider.detach();
    session.abort();
    await run.done;
    expect(host.asks[0].signal.aborted).toBe(false);
  });

  test("a gone session answers session_gone, before and while waiting", async () => {
    const gone = fakeBridge("gone");
    const goneRun = collect((await newSession(new SessionBridgeProvider(gone.bridge))).query("q"));
    await goneRun.done;
    expect(goneRun.messages).toEqual([expect.objectContaining({ code: SESSION_BRIDGE_ERROR.gone })]);
    expect(gone.asks).toHaveLength(0);

    const busy = fakeBridge("busy");
    const run = collect(
      (await newSession(new SessionBridgeProvider(busy.bridge, { pollIntervalMs: 5 }))).query("q", { busyPolicy: "wait" }),
    );
    await waitFor(() => run.messages.length === 1);
    busy.setStatus("gone");
    await run.done;
    expect(run.messages.at(-1)).toEqual(expect.objectContaining({ code: SESSION_BRIDGE_ERROR.gone }));
    expect(busy.asks).toHaveLength(0);
  });

  test("a session that ends mid-answer reports gone", async () => {
    const host = fakeBridge("ready");
    const run = collect((await newSession(new SessionBridgeProvider(host.bridge))).query("q"));
    await waitFor(() => host.asks.length === 1);
    host.asks[0].sink.error("gone");
    await run.done;
    expect(run.messages).toEqual([expect.objectContaining({ code: SESSION_BRIDGE_ERROR.gone })]);
  });

  test("a taken-over answer keeps what streamed and ends with session_taken_over and the note", async () => {
    const host = fakeBridge("ready");
    const run = collect((await newSession(new SessionBridgeProvider(host.bridge))).query("q"));
    await waitFor(() => host.asks.length === 1);
    host.asks[0].sink.delta("Because ");
    host.asks[0].sink.error("taken_over");
    host.asks[0].sink.delta("their reply");
    await run.done;
    expect(run.messages).toEqual([
      { type: "text_delta", delta: "Because " },
      { type: "error", code: SESSION_BRIDGE_ERROR.takenOver, error: SESSION_ASK_TAKEN_OVER_TEXT },
    ]);
  });

  test("blocked: refuses without a transient mode, asks transiently with one", async () => {
    const turnOnly = fakeBridge("blocked");
    const refused = collect((await newSession(new SessionBridgeProvider(turnOnly.bridge))).query("q"));
    await refused.done;
    expect(refused.messages).toEqual([expect.objectContaining({ code: SESSION_BRIDGE_ERROR.blocked })]);

    const transient = fakeBridge("blocked", { transient: true });
    const run = collect((await newSession(new SessionBridgeProvider(transient.bridge))).query("q"));
    await waitFor(() => transient.asks.length === 1);
    expect(transient.asks[0].req.mode).toBe("transient");
    transient.asks[0].sink.done("quick");
    await run.done;
  });

  test("one question at a time across every Ask AI thread", async () => {
    const host = fakeBridge("ready");
    const provider = new SessionBridgeProvider(host.bridge);
    const first = collect((await newSession(provider)).query("first"));
    await waitFor(() => host.asks.length === 1);

    const second = collect((await newSession(provider)).query("second"));
    await second.done;
    expect(second.messages).toEqual([expect.objectContaining({ code: SESSION_BRIDGE_ERROR.inFlight })]);
    expect(host.asks).toHaveLength(1);

    host.asks[0].sink.done("a");
    await first.done;
    const third = collect((await newSession(provider)).query("third"));
    await waitFor(() => host.asks.length === 2);
    host.asks[1].sink.done("b");
    await third.done;
  });
});

describe("Ask this session over the shared /api/ai endpoints", () => {
  function setup(
    host: ReturnType<typeof fakeBridge>,
    other = true,
    authorizeSessionBridgeRequest: AIEndpointDeps["authorizeSessionBridgeRequest"] = () => true,
  ) {
    const registry = new ProviderRegistry();
    if (other) {
      registry.register({
        name: "claude-agent-sdk",
        capabilities: { fork: false, resume: false, streaming: true, tools: true },
        models: [],
        createSession: async () => new (class extends BaseSession {
          async *query(): AsyncIterable<AIMessage> {
            yield { type: "result", sessionId: this.id, success: true, result: "sdk" };
          }
        })({ parentSessionId: null }),
        forkSession: async () => { throw new Error("unused"); },
        resumeSession: async () => { throw new Error("unused"); },
        dispose() {},
      });
    }
    registry.register(new SessionBridgeProvider(host.bridge, { pollIntervalMs: 5 }), SESSION_BRIDGE_PROVIDER_NAME);
    return createAIEndpoints({ registry, sessionManager: new SessionManager(), authorizeSessionBridgeRequest });
  }

  test("capabilities report the bridge's label and live status without changing the server default", async () => {
    const host = fakeBridge("busy");
    const endpoints = setup(host);
    const body = await (await endpoints["/api/ai/capabilities"](new Request("http://x/api/ai/capabilities"))).json();
    expect(body.defaultProvider).toBe("claude-agent-sdk");
    const bridge = body.providers.find((p: { id: string }) => p.id === SESSION_BRIDGE_PROVIDER_NAME);
    expect(bridge.label).toBe("Ask this session · Pi");
    expect(bridge.models).toEqual([]);
    expect(bridge.sessionBridge).toEqual({ host: "pi", status: "busy", modes: { turn: true, transient: false } });
    const other = body.providers.find((p: { id: string }) => p.id === "claude-agent-sdk");
    expect("sessionBridge" in other).toBe(false);
    expect("label" in other).toBe(false);
  });

  test("busyPolicy rides /api/ai/query; anything else is ignored", async () => {
    const host = fakeBridge("busy");
    const endpoints = setup(host);
    const created = await (await endpoints["/api/ai/session"](new Request("http://x/api/ai/session", {
      method: "POST",
      body: JSON.stringify({ context: CONTEXT, providerId: SESSION_BRIDGE_PROVIDER_NAME }),
    }))).json();

    const bogus = await endpoints["/api/ai/query"](new Request("http://x/api/ai/query", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.sessionId, prompt: "q", busyPolicy: "now!" }),
    }));
    expect(await bogus.text()).toContain(SESSION_BRIDGE_ERROR.agentBusy);

    const waiting = endpoints["/api/ai/query"](new Request("http://x/api/ai/query", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.sessionId, prompt: "q", busyPolicy: "wait" }),
    }));
    const response = await waiting;
    host.setStatus("ready");
    await waitFor(() => host.asks.length === 1);
    host.asks[0].sink.delta("hi");
    host.asks[0].sink.done("hi");
    const text = await response.text();
    expect(text).toContain('"status":"waiting"');
    expect(text).toContain('"delta":"hi"');
    expect(text).toContain("[DONE]");
  });
  test("the bridge refuses requests the runtime's host guard rejects; other providers never ask it", async () => {
    const host = fakeBridge("ready");
    let allow = true;
    const consulted: string[] = [];
    const endpoints = setup(host, true, (req) => {
      consulted.push(new URL(req.url).pathname);
      return allow;
    });
    const create = (providerId: string) => endpoints["/api/ai/session"](new Request("http://x/api/ai/session", {
      method: "POST",
      body: JSON.stringify({ context: CONTEXT, providerId }),
    }));

    // A session created while allowed cannot be queried once the guard refuses
    // (a rebinding page that learned the id from /api/ai/sessions).
    const { sessionId } = await (await create(SESSION_BRIDGE_PROVIDER_NAME)).json();
    allow = false;
    const refusedQuery = await endpoints["/api/ai/query"](new Request("http://x/api/ai/query", {
      method: "POST",
      body: JSON.stringify({ sessionId, prompt: "q" }),
    }));
    expect(refusedQuery.status).toBe(403);
    expect((await refusedQuery.json()).code).toBe(SESSION_BRIDGE_FORBIDDEN_HOST);
    const refusedCreate = await create(SESSION_BRIDGE_PROVIDER_NAME);
    expect(refusedCreate.status).toBe(403);
    expect(host.asks).toHaveLength(0);

    consulted.length = 0;
    const sdk = await create("claude-agent-sdk");
    expect(sdk.status).toBe(200);
    const sdkQuery = await endpoints["/api/ai/query"](new Request("http://x/api/ai/query", {
      method: "POST",
      body: JSON.stringify({ sessionId: (await sdk.json()).sessionId, prompt: "q" }),
    }));
    expect(await sdkQuery.text()).toContain('"result":"sdk"');
    expect(consulted).toEqual([]);
  });

  test("without a host guard the bridge never answers", async () => {
    const host = fakeBridge("ready");
    const registry = new ProviderRegistry();
    registry.register(new SessionBridgeProvider(host.bridge), SESSION_BRIDGE_PROVIDER_NAME);
    const endpoints = createAIEndpoints({ registry, sessionManager: new SessionManager() });
    const res = await endpoints["/api/ai/session"](new Request("http://x/api/ai/session", {
      method: "POST",
      body: JSON.stringify({ context: CONTEXT, providerId: SESSION_BRIDGE_PROVIDER_NAME }),
    }));
    expect(res.status).toBe(403);
  });
});

describe("the question's surface line", () => {
  // A review of several files: the session must know which file the reviewer
  // is asking about and where it sits, or "this file" is ambiguous.
  test("names the open file's place in a review of several files", () => {
    const text = formatSessionAskText(
      { mode: "annotate", annotate: { content: "<h1>Mock</h1>", filePath: "/repo/mock.html", bundlePosition: { index: 2, total: 3 } } },
      "Why this layout?",
    );
    expect(text).toContain("Surface: annotating /repo/mock.html, file 2 of 3");
    expect(formatSessionAskText(CONTEXT, "Q")).toContain("Surface: annotating /repo/notes.md\n");
  });
});
