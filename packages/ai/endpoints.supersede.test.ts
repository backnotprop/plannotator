import { expect, test } from "bun:test";
import { SessionManager } from "./session-manager.ts";
import { ProviderRegistry } from "./provider.ts";
import { createAIEndpoints } from "./endpoints.ts";
import { BaseSession } from "./base-session.ts";

const signals: AbortSignal[] = [];
const releases: Array<() => void> = [];
class Slow extends BaseSession {
  constructor() { super({ parentSessionId: null }); }
  async *query(_p: string) {
    const started = this.startQuery()!;
    signals.push(started.signal);
    yield { type: "text_delta", delta: "x" } as any;
    // Like a provider that waits for its process to confirm the stop.
    await new Promise<void>(r => releases.push(r));
    this.endQuery(started.gen);
  }
}
test("a superseded stream's late disconnect does not abort the next question", async () => {
  const reg = new ProviderRegistry();
  reg.register({ name: "slow", capabilities: { fork: false, resume: false, streaming: true, tools: false },
    async createSession() { return new Slow() as any; }, async forkSession() { return new Slow() as any; },
    async resumeSession() { return new Slow() as any; }, dispose() {} } as any);
  const sm = new SessionManager();
  const ep = createAIEndpoints({ registry: reg, sessionManager: sm });
  const post = (p: string, b: unknown) => ep[p](new Request(`http://x${p}`, { method: "POST", body: JSON.stringify(b) }));
  const { sessionId } = await (await post("/api/ai/session", { providerId: "slow", context: { mode: "plan-review", plan: { plan: "x" } } })).json() as any;
  const r1 = (await post("/api/ai/query", { sessionId, prompt: "a" })).body!.getReader();
  await r1.read();
  await post("/api/ai/abort", { sessionId, reason: "supersede" });
  const r2 = (await post("/api/ai/query", { sessionId, prompt: "b" })).body!.getReader();
  await r2.read();
  await r1.cancel();
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  releases.forEach(r => r());
});
