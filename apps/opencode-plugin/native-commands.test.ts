import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  formatSessionUrlNotice,
  normalizeAgentList,
  readListPayload,
  toBridgeMessages,
} from "./v2-client";
import { createCliStderrForwarder } from "./cli-bridge";
import { switchV2SessionAgent } from "./agent-switch";

const STUB_DIR = path.join(import.meta.dir, "commands");

/** The pre-#44765 draft: `transform` exists, `add` does not. */
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
    // No list/reload here on purpose: the reclaim loop then exits before its
    // first wait, so these tests never schedule a timer.
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

/**
 * A faithful stand-in for OpenCode's command state: transforms are appended and
 * REPLAYED in registration order, and `add` is a `Map.set`, so the last
 * transform to add a name wins (core/src/state.ts, core/src/command.ts).
 */
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
    /** Stand-in for OpenCode's ConfigCommandPlugin, which activates after us. */
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
    // The real old-host shape. `ctx.command.transform` EXISTS on `next` and
    // `latest`; only the draft tells the truth. Calling a missing `add` here
    // would throw inside the batched reload flush and abort it before commit,
    // taking every command registration down with it.
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

  test("registers exactly the three Plannotator commands when the draft supports add", async () => {
    const { deps, added } = makeDeps();
    expect(await registerNativeCommands(deps)).toBe(true);
    // Command names are the user-visible slash commands and are deliberately
    // frozen: they must match the OpenCode 1 stubs so both hosts agree.
    expect(added.map((command) => command.name)).toEqual([
      "plannotator-review",
      "plannotator-annotate",
      "plannotator-last",
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
    // Raw pass-through: flags must reach the CLI's own argument resolution
    // unparsed, exactly as OpenCode 1 forwards `input.arguments`.
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
  // OpenCode activates its own ConfigCommandPlugin AFTER package plugins, and
  // it replays the installed markdown stubs into the same name-keyed map, so a
  // setup-time registration is always overwritten on a normal install.
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
    // Config only ever calls reload() afterwards; replay order is stable, so
    // winning once must mean winning permanently.
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

    // One reclaim, then the next tick confirms ownership and the loop exits
    // instead of piling on a transform per tick.
    expect(applies).toBe(1);
  });

  test("keeps ticking while the draft probe has not run yet", async () => {
    // The probe flag only flips when the transform REPLAYS, which under boot
    // batching is at the flush after every plugin has loaded, and Plannotator
    // loads before the post-group config plugins. An early tick that reads
    // false must skip, not end the loop, or the reclaim is inert in exactly
    // the shape production has.
    const host = makeCommandHost();
    const { deps } = makeDeps({ command: host.domain });
    const apply = () => registerNativeCommands(deps).then(() => {});

    await apply();
    host.addConfigStubs();

    let ticks = 0;
    await reclaimNativeCommands({
      ctx: deps.ctx,
      apply,
      // False on the first tick, true from the second: the host flushed.
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
    const entries = [{ id: "plan", mode: "primary", hidden: false }];
    expect(normalizeAgentList(entries)).toEqual([
      { name: "plan", description: undefined, mode: "primary", hidden: false },
    ]);
    expect(normalizeAgentList({ location: {}, data: entries })).toEqual(normalizeAgentList(entries));
  });

  test("unusable responses degrade to an empty list instead of throwing", () => {
    expect(normalizeAgentList(undefined)).toEqual([]);
    expect(normalizeAgentList({ data: "nope" })).toEqual([]);
    expect(normalizeAgentList([{ mode: "primary" }])).toEqual([]);
    expect(readListPayload({ data: [{ description: "nameless" }] })).toEqual([]);
  });
});

describe("V2 agent switching", () => {
  test("switches the session agent when the host exposes switchAgent", async () => {
    const switchAgent = mock(async (_input: { sessionID: string; agent: string }) => {});
    const result = await switchV2SessionAgent({
      ctx: { session: { switchAgent } },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{ name: "build" }],
      warn: () => {},
    });

    expect(switchAgent).toHaveBeenCalledWith({ sessionID: "session-1", agent: "build" });
    expect(result).toBe("build");
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
    const warnings: string[] = [];
    const result = await switchV2SessionAgent({
      ctx: { session: { switchAgent: async () => { throw new Error("busy"); } } },
      sessionID: "session-1",
      requestedAgent: "build",
      getAgents: async () => [{ name: "build" }],
      warn: (message) => warnings.push(message),
    });

    expect(result).toBeUndefined();
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
    // Same guarantee the approval path gives: the reviewer's words must not be
    // lost because the session refused to change agent.
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
    // The invocation's own delivery was chosen at admission; a review comes
    // back minutes later, when a steer would land mid-turn.
    const { client, prompt } = makeBridge(async () => {});

    await client.session.prompt({
      path: { id: "session-1" },
      body: { parts: [{ type: "text", text: "LGTM" }] },
    });

    expect(prompt.mock.calls[0]![0]).toMatchObject({ delivery: "queue" });
  });
});

describe("V2 session context translation", () => {
  // `/plannotator-last` reads assistant text out of the session. V2 messages
  // are flat (`{ id, type, content }`) where V1 nested them under info/parts;
  // getRecentAssistantMessages reads the V1 shape.
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
    // OpenCode 1 evaluates a command template's shell interpolation BEFORE the
    // V1 plugin's command.execute.before hook can clear the parts, so a `!`
    // backtick in these shared stubs would launch a second Plannotator session
    // on every OC1 invocation. Permanently pinned.
    test(`${command.name}.md carries no shell interpolation`, () => {
      const { body } = readStub(command.name);
      expect(body).not.toContain("!`");
      // The model-mediated fallback needs the argument tail to reach the CLI.
      expect(body).toContain("$ARGUMENTS");
    });

    // The reclaim tells our definition from the config-loaded stub by reading
    // the description back out of ctx.command.list(). Identical descriptions
    // would make that check always report ownership and silently disable it.
    test(`${command.name} native description differs from the stub frontmatter`, () => {
      const { frontmatter } = readStub(command.name);
      expect(frontmatter).toContain("description:");
      expect(frontmatter).not.toContain(command.description);
    });
  }
});

describe("V2 session URL delivery", () => {
  const SESSION_URL = "http://127.0.0.1:19432";

  // cli-bridge logs every forwarded line, and the V2 client's app.log is
  // console.error, so without this each test here prints a URL into the suite
  // output. Restored per test so a real failure elsewhere still reports.
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

  // Regression: OpenCode 2's server-plugin context has no `tui` domain, so the
  // toast call optional-chained to a no-op and the URL only reached this
  // client's app.log, which is console.error — a stream OpenCode discards under
  // both default launch modes. A remote review (no auto-opened browser) then
  // showed the user nothing at all and read as a hang.
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

  // Regression: upstream's `reduceSessionRows` DROPS a synthetic message whose
  // description is empty (packages/tui/src/routes/session/rows.ts, pinned by
  // its own "hides synthetic messages without descriptions" test), and the TUI
  // renders the DESCRIPTION rather than the text. Posting text alone would put
  // the URL back out of sight, which is the exact bug this fixes.
  test("the notice carries the URL in its description, which is what the TUI renders", async () => {
    const { synthetic, ctx } = makeSyntheticCtx();
    const client = createV2BridgeClient({ ctx, getAgents: async () => [], sessionID: "session-1" });

    pushUrlLine(client);
    await Promise.resolve();

    const call = synthetic.mock.calls[0]![0] as { description?: string };
    expect(call.description).toBe(formatSessionUrlNotice(SESSION_URL));
    expect(call.description?.trim()).not.toBe("");
  });

  // Regression: without `resume: false` upstream calls `execution.wake`
  // (packages/core/src/session/session.ts), so merely showing a URL would start
  // a model turn the reviewer never asked for and burn tokens on every command.
  // #1459 extension: resume: false only defers the immediate wake; the host
  // default delivery is "steer", which any later wake (including spurious
  // idle wakes on OpenCode 2 betas) promotes into its own model turn. The
  // notice must therefore also pin queue delivery.
  test("the notice never wakes a model turn", async () => {
    const { synthetic, ctx } = makeSyntheticCtx();
    const client = createV2BridgeClient({ ctx, getAgents: async () => [], sessionID: "session-1" });

    pushUrlLine(client);
    await Promise.resolve();

    expect(synthetic.mock.calls[0]![0]).toMatchObject({ resume: false, delivery: "queue" });
  });

  // Regression: `session.synthetic` is absent on older V2 hosts, and a session
  // id is absent wherever the bridge is built outside an invocation. Probing
  // either one wrongly would throw inside the CLI's stderr pump and take the
  // whole command down; the contract is to degrade to the log instead.
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

  // Regression: a rejected synthetic must not surface as an unhandled
  // rejection, and must not consume the URL's one delivery slot — the ready-file
  // poller shares `toastedUrls` with the stderr forwarder and has to keep its
  // chance to deliver the same URL.
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
    // A second delivery path (the ready-file poller) still gets its attempt.
    pushUrlLine(client, toastedUrls);
    expect(synthetic).toHaveBeenCalledTimes(2);
  });

  // Regression: OpenCode 1 has a real toast and must keep it byte for byte. A
  // V1 client carries no `notifyUrl`, so the new seam has to stay invisible.
  test("OpenCode 1 clients still get the toast, not the notifier", () => {
    const showToast = mock((_input: unknown) => ({}));
    pushUrlLine({ tui: { showToast } });

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]![0]).toMatchObject({
      body: { title: "Plannotator", variant: "info" },
    });
  });

  // Regression: the notifier is inert unless the invocation's session id is
  // threaded into the client the native command path builds. Forgetting that
  // one argument reproduces the original invisible-URL bug with no other
  // symptom.
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
