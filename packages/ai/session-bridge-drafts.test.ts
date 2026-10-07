/**
 * #1748: unsubmitted annotations must never reach a live agent session as
 * feedback. Drives the real server path (`/api/ai/session` → `/api/ai/query`)
 * with the session-bridge provider over the real pull bridge, the host side
 * played by the real pull client, and asserts the exact text the session
 * receives.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAIEndpoints } from "./endpoints.ts";
import { ProviderRegistry } from "./provider.ts";
import { SessionManager } from "./session-manager.ts";
import {
  SESSION_ASK_HEADER,
  SESSION_BRIDGE_PROVIDER_NAME,
  SessionBridgeProvider,
  type SessionBridge,
  type SessionBridgeAskRequest,
  type SessionBridgeSink,
} from "./session-bridge.ts";
import { createPullSessionBridge } from "./session-bridge-pull.ts";
import { runPullSessionBridgeClient } from "./session-bridge-pull-client.ts";
import type { AIContext } from "./types.ts";

const TOKEN = "d".repeat(43);
const HOST = "127.0.0.1:4555";
const CONTEXT: AIContext = { mode: "annotate", annotate: { content: "# Doc", filePath: "last-message" } };

/** What a 0.28.6 editor sent as `contextUpdate` on the second question: the
 *  submitted-feedback export of the reviewer's DRAFT annotations. */
const FEEDBACK_EXPORT_OF_DRAFTS = [
  "# Message Feedback",
  "",
  "I've reviewed this message and have 1 piece of feedback:",
  "",
  '## 1. (line 3) Feedback on: "Open issues for the remaining work"',
  "> create these and assign to milestone 1.3",
  "",
  "---",
].join("\n");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const asks: Array<{ req: SessionBridgeAskRequest; sink: SessionBridgeSink }> = [];
  const bridge: SessionBridge = {
    host: "claude-code",
    modes: { turn: true, transient: false },
    status: () => "ready",
    ask(req, sink) {
      asks.push({ req, sink });
      // Answer at once, the way a session finishes a short turn.
      sink.delta("ok");
      sink.done("ok");
    },
  };
  const pull = createPullSessionBridge({
    token: TOKEN,
    host: "claude-code",
    modes: bridge.modes,
    connectTimeoutMs: 2_000,
    goneAfterMs: 2_000,
    resendAfterMs: 50,
  });
  const registry = new ProviderRegistry();
  registry.register(new SessionBridgeProvider(pull.bridge, { pollIntervalMs: 5 }), SESSION_BRIDGE_PROVIDER_NAME);
  const endpoints = createAIEndpoints({
    registry,
    sessionManager: new SessionManager(),
    authorizeSessionBridgeRequest: (req) => req.headers.get("host") === HOST,
    pullBridge: pull,
  }) as Record<string, (req: Request) => Promise<Response>>;
  const call = (path: string, init: RequestInit = {}) =>
    endpoints[path](
      new Request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...(init.headers as Record<string, string>) } }),
    );
  const controller = new AbortController();
  void runPullSessionBridgeClient({
    baseUrl: `http://${HOST}`,
    token: TOKEN,
    bridge,
    signal: controller.signal,
    pollWaitMs: 100,
    statusIntervalMs: 10,
    deltaFlushMs: 5,
    maxFailures: 2,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => call(new URL(String(url)).pathname, init ?? {})) as typeof fetch,
  });
  cleanups.push(() => {
    controller.abort();
    pull.dispose();
  });

  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

  /** Ask through `/api/ai/query` and return the text the session received. */
  const ask = async (sessionId: string, body: Record<string, unknown>): Promise<string> => {
    const before = asks.length;
    const res = await post("/api/ai/query", { sessionId, ...body });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE answer
    expect(asks.length).toBe(before + 1);
    return asks[before].req.text;
  };

  const createSession = async (): Promise<string> => {
    const res = await post("/api/ai/session", { context: CONTEXT, providerId: SESSION_BRIDGE_PROVIDER_NAME });
    expect(res.status).toBe(200);
    return ((await res.json()) as { sessionId: string }).sessionId;
  };

  return { ask, createSession };
}

describe("Ask this session: draft annotations (#1748)", () => {
  // The failure this guards: the reviewer's unsubmitted annotations were
  // pasted into the session's question turn in the submitted-feedback format
  // under "[Context update: …]", and the agent carried them out.
  test("a contextUpdate (the feedback export of drafts) never reaches the session", async () => {
    const { ask, createSession } = setup();
    const sessionId = await createSession();
    const text = await ask(sessionId, { prompt: "Is the plan complete?", contextUpdate: FEEDBACK_EXPORT_OF_DRAFTS });

    expect(text).toBe(
      [SESSION_ASK_HEADER, "Surface: annotating your last message", "", "Is the plan complete?"].join("\n"),
    );
    expect(text).not.toContain("Context update");
    expect(text).not.toContain("pieces of feedback");
    expect(text).not.toContain("piece of feedback");
    expect(text).not.toContain("Feedback on");
  });
});
