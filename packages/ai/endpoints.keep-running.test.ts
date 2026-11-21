import { expect, test } from "bun:test";
import { BaseSession } from "./base-session.ts";
import { createAIEndpoints } from "./endpoints.ts";
import { ProviderRegistry } from "./provider.ts";
import { SessionManager } from "./session-manager.ts";

/** Streams a word, then waits for the test, then finishes: what a slow answer does. */
class Slow extends BaseSession {
  signal: AbortSignal | null = null;
  finish: () => void = () => {};
  ended: Promise<void>;
  private end: () => void = () => {};

  constructor() {
    super({ parentSessionId: null });
    this.ended = new Promise((resolve) => (this.end = resolve));
  }

  async *query(_prompt: string) {
    const started = this.startQuery()!;
    this.signal = started.signal;
    yield { type: "text_delta", delta: "one" } as never;
    await new Promise<void>((resolve) => {
      this.finish = resolve;
      started.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "text_delta", delta: "two" } as never;
    this.endQuery(started.gen);
    this.end();
  }
}

async function run(keepRunningOnDisconnect?: boolean) {
  const session = new Slow();
  const registry = new ProviderRegistry();
  registry.register({
    name: "slow",
    capabilities: { fork: false, resume: false, streaming: true, tools: false },
    createSession: async () => session,
    forkSession: async () => session,
    resumeSession: async () => session,
    dispose() {},
  } as never);
  const endpoints = createAIEndpoints({ registry, sessionManager: new SessionManager(), keepRunningOnDisconnect });
  const post = (path: "/api/ai/session" | "/api/ai/query", body: unknown) => endpoints[path](new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }));
  const { sessionId } = (await (await post("/api/ai/session", { providerId: "slow", context: { mode: "plan-review", plan: { plan: "x" } } })).json()) as { sessionId: string };
  const reader = (await post("/api/ai/query", { sessionId, prompt: "a" })).body!.getReader();
  await reader.read();
  return { session, reader };
}

test("by default a dropped stream aborts the question", async () => {
  const { session, reader } = await run();
  await reader.cancel();
  expect(session.signal!.aborted).toBe(true);
});

test("with keepRunningOnDisconnect a dropped stream leaves the question running to its end", async () => {
  const { session, reader } = await run(true);
  await reader.cancel();
  expect(session.signal!.aborted).toBe(false);
  // The rest of the answer still drains: nothing throws into the provider, and it gets to finish.
  session.finish();
  await session.ended;
  expect(session.isActive).toBe(false);
});
