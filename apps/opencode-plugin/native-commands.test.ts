import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_COMMANDS,
  reclaimNativeCommands,
  registerNativeCommands,
  runNativeCommand,
  type CliCommandRequest,
} from "./native-commands";
import {
  createV2BridgeClient,
  formatInboxNotice,
  formatSessionUrlNotice,
  normalizeAgentList,
  readListPayload,
  toBridgeMessages,
} from "./v2-client";
import { createCliStderrForwarder } from "./cli-bridge";
import { switchV2SessionAgent } from "./agent-switch";

const STUB_DIR = path.join(import.meta.dir, "commands");

function legacyDraft() {
  return { list: () => [], get: () => undefined, update: () => {}, remove: () => {} };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const runCommand = mock(async (_request: CliCommandRequest) => {});
  const added: Array<{ name: string; description?: string; execute: Function }> = [];
  const transform = mock(async (apply: (draft: { add: (d: any) => void }) => void) => {
    apply({ add: (definition) => added.push(definition) });
    return { dispose: async () => {} };
  });

  const ctx: any = {
    command: { transform },
    session: { get: async () => ({ location: { directory: "/project" } }) },
    location: { directory: "/fallback" },
    ...overrides,
  };

  return {
    ctx,
    added,
    transform,
    runCommand,
    deps: {
      ctx,
      getAgents: async () => [],
      getBridgeContext: async () => ({ sharingEnabled: true }),
      runCommand,
    },
  };
}

function makeCommandHost() {
  const committed = new Map<string, { name: string; description?: string }>();
  const transforms: Array<(draft: any) => void> = [];
  const materialize = () => {
    committed.clear();
    for (const transform of transforms) transform({ add: (d: any) => committed.set(d.name, d) });
  };
  return {
    committed,
    domain: {
      transform: async (apply: (draft: any) => void) => {
        transforms.push(apply);
        materialize();
        return { dispose: async () => {} };
      },
      list: async () => ({
        location: {},
        data: [...committed.values()].map(({ name, description }) => ({ name, description })),
      }),
      reload: async () => { materialize(); },
    },
    addConfigStubs: () => {
      transforms.push((draft: any) => {
        for (const command of NATIVE_COMMANDS) {
          draft.add({ name: command.name, description: "from the markdown stub", execute: async () => {} });
        }
      });
      materialize();
    },
  };
}

describe("OpenCode 2 native command registration", () => {
  test("registers nothing when the host has no command domain", async () => {
    const { deps } = makeDeps({ command: undefined });
    expect(await registerNativeCommands(deps)).toBe(false);
  });

  test("registers nothing on a pre-#44765 draft that has no add", async () => {
    let applied = false;
    const { deps } = makeDeps({
      command: {
        transform: async (apply: (draft: any) => void) => {
          applied = true;
          apply(legacyDraft());
          return { dispose: async () => {} };
        },
      },
    });

    expect(await registerNativeCommands(deps)).toBe(false);
    expect(applied).toBe(true);
  });

  test("registers exactly the Plannotator commands when the draft supports add", async () => {
    const { deps, added } = makeDeps();
    expect(await registerNativeCommands(deps)).toBe(true);
    expect(added.map((command) => command.name)).toEqual([
      "plannotator-review",
      "plannotator-annotate",
      "plannotator-last",
      "plannotator-inbox",
    ]);
    for (const command of added) expect(command.execute).toBeInstanceOf(Function);
  });

  test("each execute runs the CLI path with the raw argument tail", async () => {
    const { deps, added, runCommand } = makeDeps();
    await registerNativeCommands(deps);

    const annotate = added.find((command) => command.name === "plannotator-annotate")!;
    await annotate.execute({
      sessionID: "session-9",
      prompt: { text: "notes.md --gate --json" },
      delivery: "steer",
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    const request = runCommand.mock.calls[0]![0]!;
    expect(request.command).toBe("plannotator-annotate");
    expect(request.sessionId).toBe("session-9");
    expect(request.rawArgs).toBe("notes.md --gate --json");
    expect(request.cwd).toBe("/project");
  });

  test("an argument-less invocation still runs with an empty tail", async () => {
    const { deps, added, runCommand } = makeDeps();
    await registerNativeCommands(deps);

    const review = added.find((command) => command.name === "plannotator-review")!;
    await review.execute({ sessionID: "session-1" });

    expect(runCommand.mock.calls[0]![0]!.rawArgs).toBe("");
  });

  test("falls back to the plugin location when the session has no directory", async () => {
    const { deps, added, runCommand } = makeDeps({
      session: { get: async () => { throw new Error("no session"); } },
    });
    await registerNativeCommands(deps);
    await added[0]!.execute({ sessionID: "session-1", prompt: { text: "" } });

    expect(runCommand.mock.calls[0]![0]!.cwd).toBe("/fallback");
  });

  test("a failing command is reported, not rethrown into OpenCode", async () => {
    const failing = mock(async () => { throw new Error("boom"); });
    const { deps, added } = makeDeps();
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args[0]); };
    try {
      await registerNativeCommands({ ...deps, runCommand: failing });
      await added[0]!.execute({ sessionID: "session-1", prompt: { text: "" } });
    } finally {
      console.error = originalError;
    }
    expect(errors.some((line) => String(line).includes("boom"))).toBe(true);
  });
});

describe("reclaiming the command names from the config-loaded stubs", () => {
  test("re-registers after the config stubs shadow the native definitions", async () => {
    const host = makeCommandHost();
    const { deps } = makeDeps({ command: host.domain });
    const apply = () => registerNativeCommands(deps).then(() => {});

    await apply();
    expect(host.committed.get("plannotator-review")?.description).toBe(NATIVE_COMMANDS[0]!.description);

    host.addConfigStubs();
    expect(host.committed.get("plannotator-review")?.description).toBe("from the markdown stub");

    await reclaimNativeCommands({
      ctx: deps.ctx,
      apply,
      isSupported: () => true,
      wait: async () => {},
    });

    for (const command of NATIVE_COMMANDS) {
      expect(host.committed.get(command.name)?.description).toBe(command.description);
    }
  });

  test("a reload after the reclaim keeps the native definitions", async () => {
    const host = makeCommandHost();
    const { deps } = makeDeps({ command: host.domain });
    const apply = () => registerNativeCommands(deps).then(() => {});

    await apply();
    host.addConfigStubs();
    await reclaimNativeCommands({ ctx: deps.ctx, apply, isSupported: () => true, wait: async () => {} });
    await host.domain.reload();

    expect(host.committed.get("plannotator-review")?.description).toBe(NATIVE_COMMANDS[0]!.description);
  });

  test("stops re-registering once ownership outlives a reclaim", async () => {
    const host = makeCommandHost();
    const { deps } = makeDeps({ command: host.domain });
    let applies = 0;
    const apply = async () => { applies += 1; await registerNativeCommands(deps); };

    await apply();
    host.addConfigStubs();
    applies = 0;
    await reclaimNativeCommands({ ctx: deps.ctx, apply, isSupported: () => true, wait: async () => {} });

    expect(applies).toBe(1);
  });

  test("keeps ticking while the draft probe has not run yet", async () => {
    const host = makeCommandHost();
    const { deps } = makeDeps({ command: host.domain });
    const apply = () => registerNativeCommands(deps).then(() => {});

    await apply();
    host.addConfigStubs();

    let ticks = 0;
    await reclaimNativeCommands({
      ctx: deps.ctx,
      apply,
      isSupported: () => ticks > 1,
      wait: async () => { ticks += 1; },
    });

    expect(host.committed.get("plannotator-review")?.description).toBe(NATIVE_COMMANDS[0]!.description);
  });

  test("does nothing on a host without list or reload, and never on an unsupported draft", async () => {
    const apply = mock(async () => {});
    await reclaimNativeCommands({
      ctx: { command: { transform: async () => ({}) } },
      apply,
      isSupported: () => true,
      wait: async () => {},
    });

    const host = makeCommandHost();
    await reclaimNativeCommands({
      ctx: { command: host.domain },
      apply,
      isSupported: () => false,
      wait: async () => {},
    });

    expect(apply).not.toHaveBeenCalled();
  });

  test("a throwing list read ends the reclaim instead of looping", async () => {
    const apply = mock(async () => {});
    await reclaimNativeCommands({
      ctx: {
        command: {
          transform: async () => ({}),
          list: async () => { throw new Error("no service"); },
          reload: async () => {},
        },
      },
      apply,
      isSupported: () => true,
      wait: async () => {},
    });

    expect(apply).not.toHaveBeenCalled();
  });
});

describe("V2 list shapes", () => {
  test("reads an agent list as a bare array or a { data } envelope", () => {
    const entries = [{
      id: "plan",
      mode: "primary",
      hidden: false,
      model: { providerID: "openai", id: "gpt-5.6-sol", variant: "high" },
    }];
    expect(normalizeAgentList(entries)).toEqual([
      {
        name: "plan",
        description: undefined,
        mode: "primary",
        hidden: false,
        model: { providerID: "openai", id: "gpt-5.6-sol", variant: "high" },
      },
    ]);
    expect(normalizeAgentList({ location: {}, data: entries })).toEqual(normalizeAgentList(entries));
  });

  test("unusable responses degrade to an empty list instead of throwing", () => {
    expect(normalizeAgentList(undefined)).toEqual([]);
    expect(normalizeAgentList({ data: "nope" })).toEqual([]);
    expect(normalizeAgentList([{ mode: "primary" }])).toEqual([]);
    expect(readListPayload({ data: [{ description: "nameless" }] })).toEqual([]);
  });

  test("drops a malformed configured model without dropping its agent", () => {
    expect(normalizeAgentList([{
      id: "build",
      model: { providerID: "openai", id: 42 },
    }])).toEqual([{
      name: "build",
      description: undefined,
      mode: undefined,
      hidden: false,
      model: undefined,
    }]);
  });
});

describe("V2 agent switching", () => {
  test("switches the session agent and its configured model", async () => {
    const calls: string[] = [];
    const switchAgent = mock(async (_input: { sessionID: string; agent: string }) => {});
    switchAgent.mockImplementation(async () => { calls.push("agent"); });
    const switchModel = mock(async () => { calls.push("model"); });
    const result = await switchV2SessionAgent({
      ctx: { session: { switchAgent, switchModel } },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{
        name: "build",
        model: { providerID: "openai", id: "gpt-5.6-terra", variant: "low" },
      }],
      warn: () => {},
    });

    expect(switchAgent).toHaveBeenCalledWith({ sessionID: "session-1", agent: "build" });
    expect(switchModel).toHaveBeenCalledWith({
      sessionID: "session-1",
      model: { providerID: "openai", id: "gpt-5.6-terra", variant: "low" },
    });
    expect(calls).toEqual(["agent", "model"]);
    expect(result).toBe("build");
  });

  test("keeps the selected model when the target agent has no configured model", async () => {
    const switchAgent = mock(async () => {});
    const switchModel = mock(async () => {});

    expect(await switchV2SessionAgent({
      ctx: { session: { switchAgent, switchModel } },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{ name: "build" }],
      warn: () => {},
    })).toBe("build");

    expect(switchAgent).toHaveBeenCalledTimes(1);
    expect(switchModel).not.toHaveBeenCalled();
  });

  test("switches the agent when the host cannot apply its configured model", async () => {
    const switchAgent = mock(async () => {});
    const warnings: string[] = [];

    expect(await switchV2SessionAgent({
      ctx: { session: { switchAgent } },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{
        name: "build",
        model: { providerID: "openai", id: "gpt-5.6-terra" },
      }],
      warn: (message) => warnings.push(message),
    })).toBe("build");

    expect(switchAgent).toHaveBeenCalledWith({ sessionID: "session-1", agent: "build" });
    expect(warnings).toHaveLength(1);
  });

  test("keeps the switched agent when its model switch fails", async () => {
    const switchAgent = mock(async () => {});
    const warnings: string[] = [];

    expect(await switchV2SessionAgent({
      ctx: {
        session: {
          switchAgent,
          switchModel: async () => { throw new Error("model unavailable"); },
        },
      },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{
        name: "build",
        model: { providerID: "openai", id: "gpt-5.6-terra" },
      }],
      warn: (message) => warnings.push(message),
    })).toBe("build");

    expect(switchAgent).toHaveBeenCalledTimes(1);
    expect(warnings.some((line) => line.includes("model unavailable"))).toBe(true);
  });

  test("warns and leaves the agent alone when the host has no switchAgent", async () => {
    const warnings: string[] = [];
    const result = await switchV2SessionAgent({
      ctx: { session: {} },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{ name: "build" }],
      warn: (message) => warnings.push(message),
    });

    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  test("a failing switch does not fail the approval", async () => {
    const switchModel = mock(async () => {});
    const warnings: string[] = [];
    const result = await switchV2SessionAgent({
      ctx: {
        session: {
          switchAgent: async () => { throw new Error("busy"); },
          switchModel,
        },
      },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{
        name: "build",
        model: { providerID: "openai", id: "gpt-5.6-terra" },
      }],
      warn: (message) => warnings.push(message),
    });

    expect(result).toBeUndefined();
    expect(switchModel).not.toHaveBeenCalled();
    expect(warnings.some((line) => line.includes("busy"))).toBe(true);
  });

  test("an unavailable or disabled agent never reaches switchAgent", async () => {
    const switchAgent = mock(async () => {});
    expect(await switchV2SessionAgent({
      ctx: { session: { switchAgent } },
      sessionID: "session-1",
      requestedAgent: "ghost",
      getAgents: async () => [{ name: "build" }],
      warn: () => {},
    })).toBeUndefined();
    expect(await switchV2SessionAgent({
      ctx: { session: { switchAgent } },
      sessionID: "session-1",
      requestedAgent: "disabled",
      getAgents: async () => [{ name: "build" }],
      warn: () => {},
    })).toBeUndefined();
    expect(switchAgent).not.toHaveBeenCalled();
  });
});

describe("V2 feedback delivery", () => {
  function makeBridge(switchAgent: (input: { sessionID: string; agent: string }) => Promise<unknown>) {
    const prompt = mock(async (_input: unknown) => ({}));
    const warnings: string[] = [];
    const client = createV2BridgeClient({
      ctx: { session: { prompt, switchAgent } },
      getAgents: async () => [],
      warn: (message) => warnings.push(message),
    });
    return { client, prompt, warnings };
  }

  test("a failing switchAgent still delivers the feedback", async () => {
    const { client, prompt, warnings } = makeBridge(async () => { throw new Error("busy"); });

    await client.session.prompt({
      path: { id: "session-1" },
      body: { agent: "build", parts: [{ type: "text", text: "please fix" }] },
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toMatchObject({ sessionID: "session-1", text: "please fix" });
    expect(warnings.some((line) => line.includes("busy"))).toBe(true);
  });

  test("feedback is queued, never steered into a running turn", async () => {
    const { client, prompt } = makeBridge(async () => {});

    await client.session.prompt({
      path: { id: "session-1" },
      body: { parts: [{ type: "text", text: "LGTM" }] },
    });

    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "queue" });
  });

  test("feedback follows a pending session-URL notice into the same promotion", async () => {
    const synthetic = mock(async (_input: unknown) => ({}));
    const prompt = mock(async (_input: unknown) => ({}));
    const client = createV2BridgeClient({
      ctx: { session: { synthetic, prompt } } as never,
      getAgents: async () => [],
      sessionID: "session-1",
    });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    await client.session.prompt({
      path: { id: "session-1" },
      body: { parts: [{ type: "text", text: "fix the null check" }] },
    });

    expect(synthetic.mock.calls[0]![0]).toMatchObject({ delivery: "steer" });
    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "steer" });
  });

  test("a tool launch's decision is queued even while its notice is pending", async () => {
    const synthetic = mock(async (_input: unknown) => ({}));
    const prompt = mock(async (_input: unknown) => ({}));
    const client = createV2BridgeClient({
      ctx: { session: { synthetic, prompt } } as never,
      getAgents: async () => [],
      sessionID: "session-1",
      alwaysQueue: true,
    });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    await client.session.prompt({
      path: { id: "session-1" },
      body: { parts: [{ type: "text", text: "fix the null check" }] },
    });

    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "queue" });
  });

  test("a notice in another session never steers the decision", async () => {
    const synthetic = mock(async (_input: unknown) => ({}));
    const prompt = mock(async (_input: unknown) => ({}));
    const client = createV2BridgeClient({
      ctx: { session: { synthetic, prompt } } as never,
      getAgents: async () => [],
      sessionID: "root",
      notice: { sessionID: "child", open: () => true },
    });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    await client.session.prompt({ path: { id: "root" }, body: { parts: [{ type: "text", text: "fix it" }] } });

    expect(synthetic.mock.calls[0]![0]).toMatchObject({ sessionID: "child" });
    expect(prompt.mock.calls[0]![0]).toMatchObject({ sessionID: "root", delivery: "queue" });
  });

  test("a closed notice window posts nothing", async () => {
    const synthetic = mock(async (_input: unknown) => ({}));
    let open = true;
    const client = createV2BridgeClient({
      ctx: { session: { synthetic, prompt: async () => ({}) } } as never,
      getAgents: async () => [],
      sessionID: "root",
      notice: { sessionID: "child", open: () => open },
    });

    open = false;
    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    expect(synthetic).not.toHaveBeenCalled();
  });

  function createTestEventStream() {
    const buffered: unknown[] = [];
    let deliver: ((result: IteratorResult<unknown>) => void) | undefined;
    let aborted = false;
    const end = () => {
      aborted = true;
      deliver?.({ value: undefined, done: true });
      deliver = undefined;
    };
    return {
      isAborted: () => aborted,
      subscribe: (options?: { signal?: AbortSignal }) => {
        options?.signal?.addEventListener("abort", end);
        return {
          [Symbol.asyncIterator]: () => ({
            next: (): Promise<IteratorResult<unknown>> => {
              if (buffered.length) return Promise.resolve({ value: buffered.shift(), done: false });
              if (aborted) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => { deliver = resolve; });
            },
            return: () => {
              end();
              return Promise.resolve({ value: undefined, done: true } as IteratorResult<unknown>);
            },
          }),
        };
      },
      emit: async (event: unknown) => {
        if (deliver) {
          const resolve = deliver;
          deliver = undefined;
          resolve({ value: event, done: false });
        } else {
          buffered.push(event);
        }
        for (let i = 0; i < 5; i++) await Promise.resolve();
      },
    };
  }

  function makeNoticeBridge(input: {
    stream: ReturnType<typeof createTestEventStream>;
    noticeRow?: unknown;
  }) {
    const synthetic = mock(async (_input: unknown) => input.noticeRow ?? { id: NOTICE_ROW_ID });
    const prompt = mock(async (_input: unknown) => ({}));
    const client = createV2BridgeClient({
      ctx: {
        session: { synthetic, prompt },
        event: { subscribe: input.stream.subscribe },
      } as never,
      getAgents: async () => [],
      sessionID: SESSION_ID,
    });
    return { client, prompt, synthetic };
  }

  const SESSION_ID = "session-1";
  const NOTICE_ROW_ID = "msg-notice";
  const FEEDBACK = { path: { id: SESSION_ID }, body: { parts: [{ type: "text", text: "fix the null check" }] } };

  test("feedback queues again once the host reports the notice promoted", async () => {
    const stream = createTestEventStream();
    const { client, prompt } = makeNoticeBridge({ stream });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    await stream.emit({
      type: "session.inbox.delivered",
      data: { sessionID: SESSION_ID, inboxID: NOTICE_ROW_ID },
    });
    await client.session.prompt(FEEDBACK);

    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "queue" });
  });

  test("the pre-rename session.input.promoted event settles the notice too", async () => {
    const stream = createTestEventStream();
    const { client, prompt } = makeNoticeBridge({ stream });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    await stream.emit({
      type: "session.input.promoted",
      data: { sessionID: SESSION_ID, inputID: NOTICE_ROW_ID },
    });
    await client.session.prompt(FEEDBACK);

    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "queue" });
  });

  test("an unrelated promotion leaves the notice pending and the feedback steered", async () => {
    const stream = createTestEventStream();
    const { client, prompt } = makeNoticeBridge({ stream });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    await stream.emit({
      type: "session.inbox.delivered",
      data: { sessionID: SESSION_ID, inboxID: "someone-elses-row" },
    });
    await stream.emit({
      type: "session.inbox.delivered",
      data: { sessionID: "other-session", inboxID: NOTICE_ROW_ID },
    });
    await client.session.prompt(FEEDBACK);

    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "steer" });
  });

  test("a notice the host reports no row id for keeps the old co-promotion", async () => {
    const stream = createTestEventStream();
    const { client, prompt } = makeNoticeBridge({ stream, noticeRow: {} });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    await stream.emit({
      type: "session.inbox.delivered",
      data: { sessionID: SESSION_ID, inboxID: NOTICE_ROW_ID },
    });
    await client.session.prompt(FEEDBACK);

    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "steer" });
  });

  test("a review that sends no feedback releases the notice watch", async () => {
    const stream = createTestEventStream();
    const synthetic = mock(async (_input: unknown) => ({ id: NOTICE_ROW_ID }));

    await runNativeCommand("plannotator-review", { sessionID: SESSION_ID }, {
      ctx: {
        session: { synthetic },
        event: { subscribe: stream.subscribe },
        location: { directory: "/tmp" },
      } as never,
      getAgents: async () => [],
      getBridgeContext: async () => ({ agents: [] }),
      runCommand: async (request) => {
        const client = request.client as { notifyUrl?: (input: { url: string; message: string }) => Promise<unknown> };
        await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
      },
    });

    expect(synthetic).toHaveBeenCalledTimes(1);
    expect(stream.isAborted()).toBe(true);
  });

  test("a rejected notice leaves the feedback queued", async () => {
    const prompt = mock(async (_input: unknown) => ({}));
    const client = createV2BridgeClient({
      ctx: {
        session: {
          synthetic: async () => {
            throw new Error("session gone");
          },
          prompt,
        },
      } as never,
      getAgents: async () => [],
      sessionID: "session-1",
    });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" }).catch(() => {});
    await client.session.prompt({
      path: { id: "session-1" },
      body: { parts: [{ type: "text", text: "fix the null check" }] },
    });

    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "queue" });
  });

  test("a notice posted after dispose opens no new event subscription", async () => {
    const stream = createTestEventStream();
    const subscribe = mock(stream.subscribe);
    const synthetic = mock(async (_input: unknown) => ({ id: NOTICE_ROW_ID }));
    const client = createV2BridgeClient({
      ctx: { session: { synthetic }, event: { subscribe } } as never,
      getAgents: async () => [],
      sessionID: SESSION_ID,
    });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    expect(subscribe).toHaveBeenCalledTimes(1);

    client.dispose();
    expect(stream.isAborted()).toBe(true);

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  test("feedback delivered while the notice is still posting is co-promoted", async () => {
    const stream = createTestEventStream();
    let admit: ((row: unknown) => void) | undefined;
    const synthetic = mock(
      () => new Promise<unknown>((resolve) => { admit = resolve; }),
    );
    const prompt = mock(async (_input: unknown) => ({}));
    const client = createV2BridgeClient({
      ctx: {
        session: { synthetic, prompt },
        event: { subscribe: stream.subscribe },
      } as never,
      getAgents: async () => [],
      sessionID: SESSION_ID,
    });

    const posting = client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" });
    await client.session.prompt(FEEDBACK);
    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "steer" });

    admit!({ id: NOTICE_ROW_ID });
    await posting;
    client.dispose();
  });

  test("a notice the host refuses lowers the provisional arm again", async () => {
    const prompt = mock(async (_input: unknown) => ({}));
    const client = createV2BridgeClient({
      ctx: {
        session: {
          synthetic: async () => { throw new Error("session gone"); },
          prompt,
        },
      } as never,
      getAgents: async () => [],
      sessionID: SESSION_ID,
    });

    await client.notifyUrl!({ url: "http://127.0.0.1:19432", message: "ready" }).catch(() => {});
    await client.session.prompt(FEEDBACK);

    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "queue" });
  });
});

describe("V2 session context translation", () => {
  test("maps flat V2 messages into the nested shape the bridge reads", () => {
    const mapped = toBridgeMessages([
      { id: "m1", type: "assistant", time: { created: 5 }, content: [{ type: "text", text: "hi" }] },
    ]) as Array<{ info: { id: string; role: string; time: { created: number } }; parts: unknown[] }>;

    expect(mapped[0]!.info).toEqual({ id: "m1", role: "assistant", time: { created: 5 } });
    expect(mapped[0]!.parts).toEqual([{ type: "text", text: "hi" }]);
  });

  test("a non-array context yields no messages", () => {
    expect(toBridgeMessages(undefined)).toEqual([]);
  });
});

describe("shared command stubs", () => {
  function readStub(name: string): { frontmatter: string; body: string } {
    const source = readFileSync(path.join(STUB_DIR, `${name}.md`), "utf-8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
    if (!match) throw new Error(`${name}.md has no frontmatter`);
    return { frontmatter: match[1]!, body: match[2]! };
  }

  for (const command of NATIVE_COMMANDS) {
    test(`${command.name}.md carries no shell interpolation`, () => {
      const { body } = readStub(command.name);
      expect(body).not.toContain("!`");
      if (command.name !== "plannotator-inbox") expect(body).toContain("$ARGUMENTS");
    });

    test(`${command.name} native description differs from the stub frontmatter`, () => {
      const { frontmatter } = readStub(command.name);
      expect(frontmatter).toContain("description:");
      expect(frontmatter).not.toContain(command.description);
    });
  }
});

describe.skipIf(process.platform === "win32")("V2 /plannotator-inbox", () => {
  const savedBin = process.env.PLANNOTATOR_BIN;
  const dirs: string[] = [];
  afterEach(() => {
    if (savedBin === undefined) delete process.env.PLANNOTATOR_BIN;
    else process.env.PLANNOTATOR_BIN = savedBin;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function stubCli(body: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "plannotator-oc2-inbox-"));
    dirs.push(dir);
    const bin = path.join(dir, "plannotator");
    const calls = path.join(dir, "calls");
    writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${calls}'\n${body}\n`, { mode: 0o755 });
    process.env.PLANNOTATOR_BIN = bin;
    return calls;
  }

  async function runInbox() {
    const synthetic = mock(async (_input: unknown) => ({}));
    const prompt = mock(async (_input: unknown) => ({}));
    const ctx = { session: { synthetic, prompt } } as any;
    const marked: string[] = [];
    await runNativeCommand("plannotator-inbox", { sessionID: "session-1" } as never, {
      ctx,
      getAgents: async () => [],
      getBridgeContext: async () => ({}),
      inboxBriefings: { mark: (sessionID: string) => void marked.push(sessionID) },
    });
    return { synthetic, prompt, marked };
  }

  test("opens the Inbox and posts its address as a notice, with no model turn", async () => {
    const calls = stubCli("echo 'http://localhost:61234/'");
    const { synthetic, prompt, marked } = await runInbox();
    expect(readFileSync(calls, "utf8").trim()).toBe("inbox --open");
    expect(synthetic).toHaveBeenCalledTimes(1);
    const notice = synthetic.mock.calls[0]![0] as { description: string; resume: boolean };
    expect(notice.description).toBe(formatInboxNotice("http://localhost:61234/"));
    expect(notice.resume).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(marked).toEqual(["session-1"]);
  });

  test("an older plannotator without --open shows that it needs updating", async () => {
    stubCli("echo 'Unknown inbox option: --open' >&2; exit 1");
    const { synthetic, prompt, marked } = await runInbox();
    expect(JSON.stringify(synthetic.mock.calls)).toContain("plannotator update");
    expect(prompt).not.toHaveBeenCalled();
    expect(marked).toEqual([]);
  });
});

describe("V2 session URL delivery", () => {
  const SESSION_URL = "http://127.0.0.1:19432";

  const originalConsoleError = console.error;
  beforeEach(() => {
    console.error = () => {};
  });
  afterEach(() => {
    console.error = originalConsoleError;
  });

  function makeSyntheticCtx() {
    const synthetic = mock(async (_input: unknown) => ({}));
    return { synthetic, ctx: { session: { synthetic } } as any };
  }

  function pushUrlLine(client: unknown, toastedUrls = new Set<string>()) {
    const forwarder = createCliStderrForwarder(client as never, toastedUrls);
    forwarder.push(`${SESSION_URL}\n`);
    return { forwarder, toastedUrls };
  }

  test("a session URL reaches the session as a synthetic notice", async () => {
    const { synthetic, ctx } = makeSyntheticCtx();
    const client = createV2BridgeClient({ ctx, getAgents: async () => [], sessionID: "session-1" });

    pushUrlLine(client);
    await Promise.resolve();

    expect(synthetic).toHaveBeenCalledTimes(1);
    const call = synthetic.mock.calls[0]![0] as { sessionID: string; text: string };
    expect(call.sessionID).toBe("session-1");
    expect(call.text).toContain(SESSION_URL);
  });

  test("the notice carries the URL in its description, which is what the TUI renders", async () => {
    const { synthetic, ctx } = makeSyntheticCtx();
    const client = createV2BridgeClient({ ctx, getAgents: async () => [], sessionID: "session-1" });

    pushUrlLine(client);
    await Promise.resolve();

    const call = synthetic.mock.calls[0]![0] as { description?: string };
    expect(call.description).toBe(formatSessionUrlNotice(SESSION_URL));
    expect(call.description?.trim()).not.toBe("");
  });

  test("the notice never wakes a model turn", async () => {
    const { synthetic, ctx } = makeSyntheticCtx();
    const client = createV2BridgeClient({ ctx, getAgents: async () => [], sessionID: "session-1" });

    pushUrlLine(client);
    await Promise.resolve();

    expect(synthetic.mock.calls[0]![0]).toMatchObject({ resume: false });
  });

  test("the notice rides the delivery that batches, not the one that isolates", async () => {
    const { synthetic, ctx } = makeSyntheticCtx();
    const client = createV2BridgeClient({ ctx, getAgents: async () => [], sessionID: "session-1" });

    pushUrlLine(client);
    await Promise.resolve();

    expect(synthetic.mock.calls[0]![0]).toMatchObject({ delivery: "steer" });
  });

  test("an older host without session.synthetic degrades instead of throwing", () => {
    const withoutSynthetic = createV2BridgeClient({
      ctx: { session: {} },
      getAgents: async () => [],
      sessionID: "session-1",
    });
    const withoutSession = createV2BridgeClient({
      ctx: makeSyntheticCtx().ctx,
      getAgents: async () => [],
    });

    expect(withoutSynthetic.notifyUrl).toBeUndefined();
    expect(withoutSession.notifyUrl).toBeUndefined();
    expect(() => pushUrlLine(withoutSynthetic)).not.toThrow();
  });

  test("a rejecting synthetic is caught and leaves the URL retryable", async () => {
    const synthetic = mock(async () => {
      throw new Error("session gone");
    });
    const client = createV2BridgeClient({
      ctx: { session: { synthetic } } as any,
      getAgents: async () => [],
      sessionID: "session-1",
    });

    const toastedUrls = new Set<string>();
    expect(() => pushUrlLine(client, toastedUrls)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastedUrls.has(SESSION_URL)).toBe(false);
    pushUrlLine(client, toastedUrls);
    expect(synthetic).toHaveBeenCalledTimes(2);
  });

  test("OpenCode 1 clients still get the toast, not the notifier", () => {
    const showToast = mock((_input: unknown) => ({}));
    pushUrlLine({ tui: { showToast } });

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]![0]).toMatchObject({
      body: { title: "Plannotator", variant: "info" },
    });
  });

  test("the native command path builds a client that can notify", async () => {
    const { ctx } = makeSyntheticCtx();
    ctx.session.get = async () => ({ location: { directory: "/project" } });
    let seen: { notifyUrl?: unknown } | undefined;

    await runNativeCommand(
      "plannotator-review",
      { sessionID: "session-1", prompt: { text: "" } },
      {
        ctx,
        getAgents: async () => [],
        getBridgeContext: async () => ({}),
        runCommand: async (request) => {
          seen = request.client as { notifyUrl?: unknown };
        },
      },
    );

    expect(typeof seen?.notifyUrl).toBe("function");
  });
});
