import { afterEach, describe, expect, test } from "bun:test";
import {
  createOpenCodeMessageId,
  createOpenCodeSessionBridge,
  markPlanReviewPending,
  readAnswerAfter,
  TAKEN_OVER_INTERRUPT_TEXT,
  TAKEN_OVER_TEXT,
  type OpenCodeSessionBridge,
} from "./opencode-session-bridge";
import {
  SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT,
  SESSION_ASK_TAKEN_OVER_TEXT,
  type SessionBridgeErrorCode,
} from "@plannotator/ai/session-bridge";

const SESSION = "ses_test";

/** A hand-driven stand-in for the plugin's `ctx.session` + `ctx.event`. */
function fakeHost(options: { events?: boolean; idle?: boolean } = {}) {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: any[] = [];
  const generates: any[] = [];
  let interrupts = 0;
  let idle = options.idle ?? true;
  const idleWaiters: Array<() => void> = [];
  let context: unknown[] = [];
  let generateResult: (value: unknown) => void = () => {};

  const emit = (type: string, data: Record<string, unknown> = {}) => {
    for (const listener of listeners) listener({ type, data: { sessionID: SESSION, ...data } });
  };
  const setIdle = (value: boolean) => {
    idle = value;
    if (value) for (const waiter of idleWaiters.splice(0)) waiter();
  };

  const ctx: any = {
    session: {
      prompt: async (input: any) => {
        prompts.push(input);
        return { id: input.id };
      },
      generate: (input: any) => {
        generates.push(input);
        return new Promise((resolve) => {
          generateResult = resolve;
        });
      },
      interrupt: async () => {
        interrupts += 1;
        return { interrupted: true };
      },
      wait: () => (idle ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve))),
      context: async () => context,
    },
    ...(options.events !== false && {
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            const queue: unknown[] = [];
            let wake: (() => void) | null = null;
            const listener = (event: unknown) => {
              queue.push(event);
              wake?.();
            };
            listeners.add(listener);
            try {
              while (!signal.aborted) {
                if (queue.length) {
                  yield queue.shift();
                  continue;
                }
                await new Promise<void>((resolve) => {
                  wake = resolve;
                  signal.addEventListener("abort", () => resolve(), { once: true });
                });
                wake = null;
              }
            } finally {
              listeners.delete(listener);
            }
          },
        }),
      },
    }),
  };

  return {
    ctx,
    emit,
    setIdle,
    prompts,
    generates,
    get interrupts() {
      return interrupts;
    },
    setContext(value: unknown[]) {
      context = value;
    },
    resolveGenerate(value: unknown) {
      generateResult(value);
    },
  };
}

function recordingSink() {
  const deltas: string[] = [];
  const tools: string[] = [];
  let done: string | undefined;
  let error: { code: SessionBridgeErrorCode; message?: string } | undefined;
  return {
    sink: {
      delta: (text: string) => deltas.push(text),
      tool: (name: string) => tools.push(name),
      done: (answer: string) => {
        done = answer;
      },
      error: (code: SessionBridgeErrorCode, message?: string) => {
        error = { code, message };
      },
    },
    deltas,
    tools,
    get done() {
      return done;
    },
    get error() {
      return error;
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

const bridges: OpenCodeSessionBridge[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  for (const release of releases.splice(0)) release();
});

function bridgeFor(host: ReturnType<typeof fakeHost>, extra: Record<string, unknown> = {}) {
  const bridge = createOpenCodeSessionBridge({ ctx: host.ctx, sessionID: SESSION, idleProbeMs: 20, busyProbeMs: 10, fallbackPollMs: 10, ...extra });
  bridges.push(bridge);
  return bridge;
}

describe("OpenCode session bridge", () => {
  test("asks as a steered prompt under our own id and streams the turn that answers it", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    const sink = recordingSink();
    bridge.ask({ askId: "a1", text: "[Plannotator Ask AI] why?", mode: "turn" }, sink.sink, new AbortController().signal);
    await waitFor(() => host.prompts.length === 1);
    const prompt = host.prompts[0];
    // "steer", so the question co-promotes with the session-URL notice the
    // command left pending instead of waking a separate turn for the notice.
    expect(prompt.delivery).toBe("steer");
    expect(prompt.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(prompt.metadata).toEqual({ source: "plannotator-ask" });

    // Output from before our question was delivered is not ours.
    host.emit("session.text.delta", { assistantMessageID: "m0", ordinal: 0, delta: "unrelated" });
    host.emit("session.execution.started");
    host.emit("session.inbox.delivered", { inboxID: prompt.id });
    host.emit("session.text.started", { assistantMessageID: "m1", ordinal: 0 });
    host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "Because " });
    host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "of X." });
    host.emit("session.text.ended", { assistantMessageID: "m1", ordinal: 0, text: "Because of X." });
    host.emit("session.tool.input.started", { assistantMessageID: "m1", id: "t1", name: "read" });
    // A block delivered whole, with no deltas, is replayed from text.ended.
    host.emit("session.text.started", { assistantMessageID: "m2", ordinal: 0 });
    host.emit("session.text.ended", { assistantMessageID: "m2", ordinal: 0, text: "Also Y." });
    host.emit("session.execution.succeeded");

    await waitFor(() => sink.done !== undefined);
    expect(sink.done).toBe("Because of X.\n\nAlso Y.");
    expect(sink.deltas.join("")).toBe("Because of X.\n\nAlso Y.");
    expect(sink.tools).toEqual(["read"]);
  });

  test("reports busy while the session runs, blocked while a plan review waits, gone once deleted", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    await waitFor(() => bridge.status() === "ready");
    host.emit("session.execution.started");
    await waitFor(() => bridge.status() === "busy");
    host.emit("session.execution.succeeded");
    await waitFor(() => bridge.status() === "ready");

    const release = markPlanReviewPending(SESSION);
    releases.push(release);
    expect(bridge.status()).toBe("blocked");
    release();
    expect(bridge.status()).toBe("ready");

    host.emit("session.deleted");
    await waitFor(() => bridge.status() === "gone");
  });

  test("a turn question never steers into a run the session started since its last status report", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    await waitFor(() => bridge.status() === "ready");
    host.emit("session.execution.started");
    await waitFor(() => bridge.status() === "busy");
    const sink = recordingSink();
    bridge.ask({ askId: "a1", text: "q", mode: "turn" }, sink.sink, new AbortController().signal);
    expect(sink.error?.code).toBe("busy");
    expect(host.prompts.length).toBe(0);
  });

  test("a session already running when the bridge starts reads busy until it goes idle", async () => {
    const host = fakeHost({ idle: false });
    const bridge = bridgeFor(host);
    await waitFor(() => bridge.status() === "busy");
    host.setIdle(true);
    await waitFor(() => bridge.status() === "ready");
  });

  test("stopping our running turn interrupts it; the interrupted run reports aborted", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    const sink = recordingSink();
    const controller = new AbortController();
    bridge.ask({ askId: "a1", text: "q", mode: "turn" }, sink.sink, controller.signal);
    await waitFor(() => host.prompts.length === 1);
    host.emit("session.inbox.delivered", { inboxID: host.prompts[0].id });
    host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "partial" });
    controller.abort();
    await waitFor(() => host.interrupts === 1);
    host.emit("session.execution.interrupted", { reason: "user" });
    await waitFor(() => sink.error !== undefined);
    expect(sink.error?.code).toBe("aborted");
  });

  test("a question stopped before delivery never interrupts other work; it is stopped once delivered", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    const sink = recordingSink();
    const controller = new AbortController();
    bridge.ask({ askId: "a1", text: "q", mode: "turn" }, sink.sink, controller.signal);
    await waitFor(() => host.prompts.length === 1);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.interrupts).toBe(0);
    host.emit("session.inbox.delivered", { inboxID: host.prompts[0].id });
    await waitFor(() => host.interrupts === 1);
  });

  // The failure these guard: the person typed into the OpenCode run answering
  // the reviewer's question, and the reply to THEIR prompt streamed into
  // Plannotator as the answer, and a Plannotator Stop interrupted their work.
  test("a prompt delivered into the run answering our question takes it over: streaming stops, Stop and interrupt leave the run alone", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    const sink = recordingSink();
    const controller = new AbortController();
    bridge.ask({ askId: "a1", text: "q", mode: "turn" }, sink.sink, controller.signal);
    await waitFor(() => host.prompts.length === 1);
    host.emit("session.execution.started");
    host.emit("session.inbox.delivered", { inboxID: host.prompts[0].id });
    host.emit("session.step.started", { assistantMessageID: "m1" });
    host.emit("session.text.started", { assistantMessageID: "m1", ordinal: 0 });
    host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "Because " });
    // The person steers a prompt of their own into the running execution.
    host.emit("session.inbox.enqueued", { inboxID: "msg_person", item: { type: "user", delivery: "steer", payload: {} } });
    host.emit("session.inbox.delivered", { inboxID: "msg_person" });
    host.emit("session.step.started", { assistantMessageID: "m2" });
    host.emit("session.text.started", { assistantMessageID: "m2", ordinal: 0 });
    host.emit("session.text.delta", { assistantMessageID: "m2", ordinal: 0, delta: "Fixed the tests." });

    await waitFor(() => sink.error !== undefined);
    expect(sink.error).toEqual({ code: "taken_over", message: TAKEN_OVER_TEXT });
    expect(sink.deltas).toEqual(["Because "]);

    controller.abort();
    await expect(Promise.resolve(bridge.interrupt?.())).rejects.toThrow(TAKEN_OVER_INTERRUPT_TEXT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.interrupts).toBe(0);

    // Once that execution ends, interrupting the session works again.
    host.emit("session.execution.succeeded");
    host.emit("session.execution.started");
    await bridge.interrupt?.();
    expect(host.interrupts).toBe(1);
  });

  test("a row promoted in the same batch as our question (a command's notice) is not a take-over", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    const sink = recordingSink();
    bridge.ask({ askId: "a1", text: "q", mode: "turn" }, sink.sink, new AbortController().signal);
    await waitFor(() => host.prompts.length === 1);
    host.emit("session.execution.started");
    // Even when the notices are user rows, the same batch as ours takes nothing over.
    for (const id of ["msg_notice", "msg_notice_after"]) {
      host.emit("session.inbox.enqueued", { inboxID: id, item: { type: "user", delivery: "steer", payload: {} } });
    }
    host.emit("session.inbox.delivered", { inboxID: "msg_notice" });
    host.emit("session.inbox.delivered", { inboxID: host.prompts[0].id });
    host.emit("session.inbox.delivered", { inboxID: "msg_notice_after" });
    host.emit("session.step.started", { assistantMessageID: "m1" });
    host.emit("session.text.started", { assistantMessageID: "m1", ordinal: 0 });
    host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "Because of X." });
    host.emit("session.execution.succeeded");
    await waitFor(() => sink.done !== undefined);
    expect(sink.done).toBe("Because of X.");
    expect(sink.error).toBeUndefined();
  });

  // The failure this guards: a synthetic notice or a compaction delivered
  // mid-answer cut the answer off with a take-over note.
  test("only a USER row takes the run over: synthetic, compaction, move and unseen rows do not", async () => {
    for (const kind of ["synthetic", "compaction", "move", null]) {
      const host = fakeHost();
      const bridge = bridgeFor(host);
      const sink = recordingSink();
      bridge.ask({ askId: "a1", text: "q", mode: "turn" }, sink.sink, new AbortController().signal);
      await waitFor(() => host.prompts.length === 1);
      host.emit("session.execution.started");
      host.emit("session.inbox.delivered", { inboxID: host.prompts[0].id });
      host.emit("session.step.started", { assistantMessageID: "m1" });
      host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "Because " });
      if (kind) host.emit("session.inbox.enqueued", { inboxID: "msg_row", item: { type: kind, delivery: "steer", payload: {} } });
      host.emit("session.inbox.delivered", { inboxID: "msg_row" });
      host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "of X." });
      host.emit("session.execution.succeeded");
      await waitFor(() => sink.done !== undefined || sink.error !== undefined);
      expect([kind, sink.done, sink.error]).toEqual([kind, "Because of X.", undefined]);
    }
  });

  test("a user row arriving after the answer finished (last step stopped, no tool calls) settles the answer as done", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    const sink = recordingSink();
    bridge.ask({ askId: "a1", text: "q", mode: "turn" }, sink.sink, new AbortController().signal);
    await waitFor(() => host.prompts.length === 1);
    host.emit("session.execution.started");
    host.emit("session.inbox.delivered", { inboxID: host.prompts[0].id });
    host.emit("session.step.started", { assistantMessageID: "m1" });
    host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "Done." });
    host.emit("session.step.ended", { assistantMessageID: "m1", finish: "stop" });
    host.emit("session.inbox.enqueued", { inboxID: "msg_next", item: { type: "user", delivery: "queue", payload: {} } });
    host.emit("session.inbox.delivered", { inboxID: "msg_next" });
    host.emit("session.step.started", { assistantMessageID: "m2" });
    host.emit("session.text.delta", { assistantMessageID: "m2", ordinal: 0, delta: "Next thing." });
    await waitFor(() => sink.done !== undefined);
    expect(sink.done).toBe("Done.");
    expect(sink.error).toBeUndefined();
    expect(sink.deltas).toEqual(["Done."]);
  });

  // The failure this guards: an OpenAI-compatible provider reporting "stop"
  // on a step that called tools made a cut answer read as finished.
  test('a step that called tools is never a finished answer, even when its finish says "stop"', async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    const sink = recordingSink();
    bridge.ask({ askId: "a1", text: "q", mode: "turn" }, sink.sink, new AbortController().signal);
    await waitFor(() => host.prompts.length === 1);
    host.emit("session.execution.started");
    host.emit("session.inbox.delivered", { inboxID: host.prompts[0].id });
    host.emit("session.step.started", { assistantMessageID: "m1" });
    host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "Let me look." });
    host.emit("session.tool.input.started", { assistantMessageID: "m1", id: "t1", name: "read" });
    host.emit("session.step.ended", { assistantMessageID: "m1", finish: "stop" });
    host.emit("session.inbox.enqueued", { inboxID: "msg_person", item: { type: "user", delivery: "steer", payload: {} } });
    host.emit("session.inbox.delivered", { inboxID: "msg_person" });
    await waitFor(() => sink.error !== undefined || sink.done !== undefined);
    expect(sink.done).toBeUndefined();
    expect(sink.error).toEqual({ code: "taken_over", message: TAKEN_OVER_TEXT });
  });

  test("the plugin sends the same take-over texts the provider would", () => {
    // Spelled out in the plugin so an older CLI server still shows them.
    expect(TAKEN_OVER_TEXT).toBe(SESSION_ASK_TAKEN_OVER_TEXT);
    expect(TAKEN_OVER_INTERRUPT_TEXT).toBe(SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT);
  });

  test("refuses an interrupt while the session waits on a plan review", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host);
    releases.push(markPlanReviewPending(SESSION));
    await expect(Promise.resolve(bridge.interrupt?.())).rejects.toThrow();
    expect(host.interrupts).toBe(0);
  });

  test("a transient question answers from session.generate without touching the transcript", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host, { modes: { turn: false, transient: true } });
    const sink = recordingSink();
    bridge.ask({ askId: "a1", text: "what is step 2?", mode: "transient" }, sink.sink, new AbortController().signal);
    await waitFor(() => host.generates.length === 1);
    expect(host.generates[0]).toEqual({ sessionID: SESSION, prompt: "what is step 2?" });
    host.resolveGenerate({ text: "Step 2 migrates the table." });
    await waitFor(() => sink.done !== undefined);
    expect(sink.done).toBe("Step 2 migrates the table.");
    expect(host.prompts.length).toBe(0);
  });

  test("an empty transient answer (the model reached for a tool) is a failure, and an aborted one is dropped", async () => {
    const host = fakeHost();
    const bridge = bridgeFor(host, { modes: { turn: false, transient: true } });
    const empty = recordingSink();
    bridge.ask({ askId: "a1", text: "q", mode: "transient" }, empty.sink, new AbortController().signal);
    await waitFor(() => host.generates.length === 1);
    host.resolveGenerate({ text: "" });
    await waitFor(() => empty.error !== undefined);
    expect(empty.error?.code).toBe("failed");

    const dropped = recordingSink();
    const controller = new AbortController();
    bridge.ask({ askId: "a2", text: "q", mode: "transient" }, dropped.sink, controller.signal);
    await waitFor(() => host.generates.length === 2);
    controller.abort();
    host.resolveGenerate({ text: "late" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dropped.done).toBeUndefined();
    expect(dropped.error).toBeUndefined();
  });

  test("with no event stream, the answer is read from the session context once it is idle", async () => {
    const host = fakeHost({ events: false });
    const bridge = bridgeFor(host);
    const sink = recordingSink();
    bridge.ask({ askId: "a1", text: "q", mode: "turn" }, sink.sink, new AbortController().signal);
    await waitFor(() => host.prompts.length === 1);
    const id = host.prompts[0].id;
    host.setContext([
      { id: "msg_old", type: "user", content: [{ type: "text", text: "earlier" }] },
      { id, type: "user", content: [{ type: "text", text: "q" }] },
      { id: "msg_a", type: "assistant", content: [{ type: "text", text: "The answer." }] },
    ]);
    await waitFor(() => sink.done !== undefined);
    expect(sink.done).toBe("The answer.");
  });

  // A review's bridge and Plannotator Snapshots' bridge can be open on one
  // session at once. The failure: two questions run in one session together.
  test("one question at a time per session, across bridges", async () => {
    const host = fakeHost();
    const review = bridgeFor(host);
    const snapshots = bridgeFor(host);
    const first = recordingSink();
    review.ask({ askId: "a1", text: "[Plannotator Ask AI] first?", mode: "turn" }, first.sink, new AbortController().signal);
    await waitFor(() => host.prompts.length === 1);
    const second = recordingSink();
    snapshots.ask({ askId: "a2", text: "[Plannotator Ask AI] second?", mode: "turn" }, second.sink, new AbortController().signal);
    expect(second.error?.code).toBe("busy");
    expect(host.prompts).toHaveLength(1);

    // The first answers; the session's slot is free again.
    host.emit("session.execution.started");
    host.emit("session.inbox.delivered", { inboxID: host.prompts[0].id });
    host.emit("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "One." });
    host.emit("session.execution.succeeded");
    await waitFor(() => first.done !== undefined);
    const third = recordingSink();
    snapshots.ask({ askId: "a3", text: "[Plannotator Ask AI] third?", mode: "turn" }, third.sink, new AbortController().signal);
    await waitFor(() => host.prompts.length === 2);
    expect(third.error).toBeUndefined();
  });
});

describe("OpenCode message ids", () => {
  test("follow OpenCode's ascending id shape and sort by creation time", () => {
    const a = createOpenCodeMessageId(1_791_000_000_000);
    const b = createOpenCodeMessageId(1_791_000_000_000);
    const c = createOpenCodeMessageId(1_791_000_000_001);
    expect(a).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect([c, b, a].sort()).toEqual([a, b, c]);
  });

  test("readAnswerAfter stops at the next user message", () => {
    expect(readAnswerAfter([
      { id: "msg_q", type: "user" },
      { id: "msg_a", type: "assistant", content: [{ type: "text", text: "one" }, { type: "tool" }] },
      { id: "msg_b", type: "assistant", content: [{ type: "text", text: "two" }] },
      { id: "msg_u", type: "user" },
      { id: "msg_c", type: "assistant", content: [{ type: "text", text: "not ours" }] },
    ], "msg_q")).toBe("one\n\ntwo");
    expect(readAnswerAfter([], "msg_q")).toBeUndefined();
  });
});
