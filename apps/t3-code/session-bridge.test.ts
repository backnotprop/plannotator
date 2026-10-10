import { describe, expect, test } from "bun:test";
import type { SessionBridgeSink } from "@plannotator/ai/session-bridge";
import { T3SessionBridge } from "./session-bridge";
import { T3Thread, t3Endpoint, type T3Rpc, type T3ThreadRead, type T3TimelineItem } from "./t3-client";

function item(position: number, type: string, text: string, overrides: Partial<T3TimelineItem> = {}): T3TimelineItem {
  return { position, itemId: `item-${position}`, messageId: type === "user_message" ? "question" : null,
    runId: "answer-run", sourceThreadId: "thread-a", type, text, status: "completed", textTruncated: false, ...overrides };
}
function snapshot(items: T3TimelineItem[] = [], overrides: Partial<T3ThreadRead["thread"]> = {}): T3ThreadRead {
  return { thread: { threadId: "thread-a", projectId: "project", status: "idle", itemCount: 20, activeRunId: null, latestRunId: null,
    worktreePath: null, archived: false, pendingRequestCount: 0, ...overrides }, items,
    recentRuns: [{ runId: "answer-run", status: "completed", startedAt: new Date().toISOString() }], nextPosition: null, hasMore: false };
}
class Scripted implements T3Rpc {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  constructor(readonly read: (args: Record<string, unknown>) => T3ThreadRead) {}
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === "t3_thread_send") return { threadId: "thread-a", messageId: "question", runId: "answer-run", status: "queued", delivery: "queued" };
    return this.read(args);
  }
}
async function ask(rpc: T3Rpc, signal = new AbortController().signal): Promise<{ answer?: string; code?: string; message?: string; partial: string }> {
  const bridge = new T3SessionBridge(new T3Thread(rpc, "thread-a"), 5, 1000);
  await bridge.refresh();
  return new Promise((resolve) => {
    let partial = "";
    const sink: SessionBridgeSink = { delta: (text) => { partial += text; }, done: (answer) => resolve({ answer, partial }), error: (code, message) => resolve({ code, message, partial }) };
    bridge.ask({ askId: "ask-a", text: "Why?", mode: "turn" }, sink, signal);
  });
}

describe("T3 question correlation", () => {
  test("queues a turn, follows all timeline pages and retrieves truncated text", async () => {
    const rpc = new Scripted((args) => {
      if (args.itemId) return snapshot([item(21, "assistant_message", " remainder")]);
      if (args.afterPosition === 20) return snapshot([item(21, "assistant_message", "Answer", { textTruncated: true, nextTextOffset: 6 })]);
      if (args.afterPosition === 19) return { ...snapshot([item(20, "user_message", "Why?")]), hasMore: true, nextPosition: 20 };
      return snapshot();
    });
    expect(await ask(rpc)).toEqual({ answer: "Answer remainder", partial: "" });
    expect(rpc.calls.find((call) => call.name === "t3_thread_send")?.args).toMatchObject({ threadId: "thread-a", mode: "queue", clientRequestId: "plannotator-ask:ask-a" });
    expect(rpc.calls.some((call) => call.args.textOffset === 6)).toBe(true);
  });
  test("a foreign prompt in the answer run settles with its partial answer", async () => {
    const rpc = new Scripted((args) => args.afterPosition === 19 ? snapshot([item(20, "user_message", "Why?"), item(21, "assistant_message", "Partial"), item(22, "user_message", "human steer", { messageId: "foreign" })]) : snapshot());
    expect(await ask(rpc)).toEqual({ code: "taken_over", message: undefined, partial: "Partial" });
  });
  test("a takeover retains the original answer without including the foreign prompt's reply", async () => {
    const rpc = new Scripted((args) => args.afterPosition === 19 ? snapshot([
      item(20, "user_message", "Why?"),
      item(21, "assistant_message", "Original answer"),
      item(22, "user_message", "Change topic", { messageId: "foreign" }),
      item(23, "assistant_message", "Answer to foreign prompt"),
    ]) : snapshot());
    expect(await ask(rpc)).toEqual({ code: "taken_over", message: undefined, partial: "Original answer" });
  });
  test("a takeover omits mutable or truncated answers rather than reading them after the new prompt", async () => {
    for (const unfinished of [{ status: "running" }, { textTruncated: true, nextTextOffset: 7 }]) {
      const rpc = new Scripted((args) => {
        if (args.itemId) throw new Error("Text fetched after takeover may already answer the foreign prompt");
        return args.afterPosition === 19 ? snapshot([
          item(20, "user_message", "Why?"),
          item(21, "assistant_message", "Mutable", unfinished),
          item(22, "user_message", "Change topic", { messageId: "foreign" }),
        ]) : snapshot();
      });
      expect(await ask(rpc)).toEqual({ code: "taken_over", message: undefined, partial: "" });
      expect(rpc.calls.some((call) => call.args.itemId)).toBe(false);
    }
  });
  test("queued runs belonging to another prompt do not contaminate the answer", async () => {
    const rpc = new Scripted((args) => args.afterPosition === 19 ? snapshot([item(20, "user_message", "Why?"), item(21, "user_message", "later", { messageId: "foreign", runId: "other" }), item(22, "assistant_message", "Other", { runId: "other" }), item(23, "assistant_message", "Ours")]) : snapshot());
    expect((await ask(rpc)).answer).toBe("Ours");
  });
  test("a queued question promoted to someone else's run is taken over", async () => {
    const rpc = new Scripted((args) => args.afterPosition === 19 ? snapshot([item(20, "user_message", "Why?", { runId: "steered-run" })]) : snapshot());
    expect((await ask(rpc)).code).toBe("taken_over");
  });
  test.each(["busy", "blocked", "gone"])("refuses an unavailable %s thread without sending", async (state) => {
    const rpc = new Scripted(() => snapshot([], state === "busy" ? { activeRunId: "other", status: "running" } : state === "blocked" ? { pendingRequestCount: 1 } : { archived: true }));
    expect((await ask(rpc)).code).toBe(state);
    expect(rpc.calls.filter((call) => call.name === "t3_thread_send")).toHaveLength(0);
  });
  test("cancellation stops listening and never interrupts T3", async () => {
    const rpc = new Scripted((args) => args.afterPosition === 19 ? { ...snapshot([item(20, "user_message", "Why?")]), recentRuns: [{ runId: "answer-run", status: "running", startedAt: new Date().toISOString() }] } : snapshot());
    const abort = new AbortController();
    const result = ask(rpc, abort.signal);
    setTimeout(() => abort.abort(), 20);
    expect((await result).code).toBe("aborted");
    expect(rpc.calls.some((call) => call.name.includes("interrupt"))).toBe(false);
  });
  test("a terminated run and a completed run with no answer are failures", async () => {
    for (const status of ["failed", "completed"]) {
      const rpc = new Scripted((args) => args.afterPosition === 19 ? { ...snapshot([item(20, "user_message", "Why?")]), recentRuns: [{ runId: "answer-run", status, startedAt: null }] } : snapshot());
      expect((await ask(rpc)).code).toBe("failed");
    }
  });
  test("an empty transcript omits the unsupported negative cursor", async () => {
    let sent = false;
    const rpc: T3Rpc = { async call(name, args) {
      if (name === "t3_thread_send") { sent = true; return { threadId: "thread-a", messageId: "question", runId: "answer-run", status: "queued", delivery: "queued" }; }
      expect(args.afterPosition).toBeUndefined();
      return snapshot(sent ? [item(0, "user_message", "Why?"), item(1, "assistant_message", "Yes")] : [], { itemCount: sent ? 2 : 0 });
    } };
    expect((await ask(rpc)).answer).toBe("Yes");
  });
  test("thread mismatches and stalled pagination are refused", async () => {
    await expect(new T3Thread(new Scripted(() => snapshot([], { threadId: "wrong" })), "thread-a").read()).rejects.toThrow("different thread");
    await expect(new T3Thread(new Scripted(() => ({ ...snapshot(), hasMore: true, nextPosition: 20 })), "thread-a").itemsAfter(19)).rejects.toThrow("did not advance");
  });
  test("a recovered question finds the original receipt's answer before the new cursor", async () => {
    const rpc = new Scripted((args) => args.afterPosition === 19 ? snapshot() : snapshot([item(4, "user_message", "Why?"), item(5, "assistant_message", "Recovered answer")]));
    expect((await ask(rpc)).answer).toBe("Recovered answer");
  });
  test("endpoint validation preserves the advertised local or HTTPS address", () => {
    expect(t3Endpoint("http://127.0.0.1:3773/mcp").href).toBe("http://127.0.0.1:3773/mcp");
    expect(() => t3Endpoint("http://example.com/mcp")).toThrow("HTTPS");
    expect(() => t3Endpoint("https://example.com/mcp?token=secret")).toThrow("without credentials");
  });
});
