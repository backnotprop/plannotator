import { afterEach, describe, expect, mock, test } from "bun:test";
import serverPlugin, {
  createPlanReadyNotifier,
  pushComposedSystemReminder,
  replacePlanningSystemParts,
} from "./server";
import { createV2BridgeClient, formatSessionUrlNotice } from "./v2-client";
import { readFileSync } from "node:fs";
import path from "node:path";

const originalAllowSubagents = process.env.PLANNOTATOR_ALLOW_SUBAGENTS;

afterEach(() => {
  if (originalAllowSubagents === undefined) delete process.env.PLANNOTATOR_ALLOW_SUBAGENTS;
  else process.env.PLANNOTATOR_ALLOW_SUBAGENTS = originalAllowSubagents;
});

type SessionContextHook = (event: {
  agent: string;
  system: Array<{ type: "text"; text: string }>;
  messages: unknown[];
  tools: Record<string, { description: string; input: Record<string, unknown> }>;
}) => Promise<void> | void;

function createContext(
  options: Record<string, unknown> = {},
  agents: Array<{ id: string; description?: string; mode: string; hidden: boolean }> = [],
  hostOverrides: {
    // Pre-#44765 hosts DO expose command.transform, but hand the callback a
    // draft with no `add`. The adapter must then register nothing, throw
    // nothing, and behave exactly as it did before.
    command?: { transform: (apply: (draft: any) => void) => Promise<unknown> };
    agentListShape?: "envelope" | "array";
  } = {},
) {
  let toolDefinition: Record<string, any> | undefined;
  let sessionContextHook: SessionContextHook | undefined;
  const sessionGet = mock(async () => ({ location: { directory: "/project" } }));

  return {
    context: {
      options,
      ...(hostOverrides.command ? { command: hostOverrides.command } : {}),
      agent: {
        list: async () => (hostOverrides.agentListShape === "array"
          ? agents
          : { location: { directory: "/project" }, data: agents }),
        transform: async () => ({ dispose: async () => {} }),
      },
      session: {
        get: sessionGet,
        hook: async (name: string, callback: SessionContextHook) => {
          if (name === "context") sessionContextHook = callback;
          return { dispose: async () => {} };
        },
      },
      tool: {
        transform: async (callback: (draft: { add: (tool: Record<string, any>) => void }) => void) => {
          callback({
            add(tool) {
              toolDefinition = tool;
            },
          });
          return { dispose: async () => {} };
        },
      },
    },
    getToolDefinition: () => toolDefinition,
    getSessionContextHook: () => sessionContextHook,
    sessionGet,
  };
}

describe("OpenCode V2 server plugin", () => {
  test("exports a stable V2 plugin object", () => {
    expect(serverPlugin.id).toBe("plannotator");
    expect(serverPlugin.setup).toBeInstanceOf(Function);
  });

  test("registers submit_plan with the V2 JSON Schema tool contract", async () => {
    const testContext = createContext();
    await serverPlugin.setup(testContext.context as never);

    const tool = testContext.getToolDefinition();
    expect(tool?.name).toBe("submit_plan");
    expect(tool?.input).toEqual({
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: "number", description: "1-indexed start line (inclusive)" },
              end: {
                type: "number",
                description: "1-indexed end line (inclusive). Omit to replace from start through end of file.",
              },
              content: { type: "string", description: "Replacement content. Empty string deletes the line range." },
            },
            required: ["start", "content"],
            additionalProperties: false,
          },
          description: "Array of line-range edits to apply to the plan.",
        },
      },
      required: ["edits"],
      additionalProperties: false,
    });
    expect(tool?.options).toEqual({ codemode: false });
    expect(tool?.execute).toBeInstanceOf(Function);
  });

  test("resolves cwd from the V2 session and returns V2 tool content", async () => {
    const testContext = createContext();
    await serverPlugin.setup(testContext.context as never);

    const result = await testContext.getToolDefinition()?.execute(
      { edits: [] },
      {
        sessionID: "session-1",
        agent: "plan",
        messageID: "message-1",
        callID: "call-1",
        progress: async () => {},
      },
    );

    expect(testContext.sessionGet).toHaveBeenCalledWith({ sessionID: "session-1" });
    expect(result).toEqual({
      content: "Error: No edits provided. Pass at least one edit with start and content.",
    });
  });

  test("uses the context hook for planning prompts and tool visibility", async () => {
    const testContext = createContext();
    await serverPlugin.setup(testContext.context as never);
    const hook = testContext.getSessionContextHook();
    expect(hook).toBeInstanceOf(Function);

    const planningEvent = {
      agent: "plan",
      system: [
        { type: "text" as const, text: "Base system prompt", metadata: { source: "base" } },
        { type: "text" as const, text: "Earlier plugin prompt", cache: { type: "ephemeral" } },
      ],
      messages: [],
      tools: {
        submit_plan: { description: "Submit", input: {} },
        plan_exit: { description: "Exit", input: {} },
        todowrite: { description: "Write todos", input: {} },
      },
    };
    await hook?.(planningEvent);

    // #1114: the planning path emits ONE composed system part (multi-part
    // system arrays corrupt Qwen3.x Jinja chat templates). Existing text
    // survives, in order, ahead of the planning prompt.
    expect(planningEvent.system.length).toBe(1);
    const composedText = planningEvent.system[0]!.text;
    expect(composedText).toContain("Base system prompt");
    expect(composedText).toContain("Earlier plugin prompt");
    expect(composedText).toContain("## Plannotator");
    expect(composedText.indexOf("Base system prompt"))
      .toBeLessThan(composedText.indexOf("Earlier plugin prompt"));
    expect(composedText.indexOf("Earlier plugin prompt"))
      .toBeLessThan(composedText.indexOf("## Plannotator"));
    expect(planningEvent.tools.plan_exit.description).toContain("Use submit_plan instead");
    expect(planningEvent.tools.todowrite.description).toContain("use submit_plan instead");

    const buildEvent = {
      agent: "build",
      system: [{ type: "text" as const, text: "Base system prompt" }],
      messages: [],
      tools: {
        submit_plan: { description: "Submit", input: {} },
      },
    };
    await hook?.(buildEvent);
    expect(buildEvent.tools.submit_plan).toBeUndefined();
    expect(buildEvent.system).toEqual([{ type: "text", text: "Base system prompt" }]);

    const strippedEvent = {
      agent: "plan",
      system: [{ type: "text" as const, text: "Call plan_exit when ready." }],
      messages: [],
      tools: {
        submit_plan: { description: "Submit", input: {} },
      },
    };
    await hook?.(strippedEvent);
    const strippedSystemText = strippedEvent.system.map((part) => part.text);
    expect(strippedSystemText.some((text) => text.startsWith("## Plannotator"))).toBe(true);
    expect(strippedSystemText.join("\n")).not.toContain("undefined");
  });

  test("keeps all-agents mode scoped to primary agents by default", async () => {
    delete process.env.PLANNOTATOR_ALLOW_SUBAGENTS;
    const testContext = createContext(
      { workflow: "all-agents" },
      [{ id: "researcher", mode: "subagent", hidden: false }],
    );
    await serverPlugin.setup(testContext.context as never);
    const event = {
      agent: "researcher",
      system: [{ type: "text" as const, text: "Base system prompt" }],
      messages: [],
      tools: {
        submit_plan: { description: "Submit", input: {} },
      },
    };

    await testContext.getSessionContextHook()?.(event);
    expect(event.tools.submit_plan).toBeUndefined();
  });

  test("registers the slash commands only on a host that exposes the command API", async () => {
    const registered: string[] = [];
    const withCommands = createContext({}, [], {
      command: {
        transform: async (apply) => {
          apply({ add: (definition: { name: string }) => registered.push(definition.name) });
          return { dispose: async () => {} };
        },
      },
    });
    await serverPlugin.setup(withCommands.context as never);
    expect(registered).toEqual([
      "plannotator-review",
      "plannotator-annotate",
      "plannotator-last",
    ]);

    // No command domain: nothing registered, and the pre-existing submit_plan
    // contract is untouched.
    const withoutCommands = createContext();
    await serverPlugin.setup(withoutCommands.context as never);
    expect(withoutCommands.getToolDefinition()?.name).toBe("submit_plan");
  });

  test("a pre-#44765 command draft registers nothing and does not fail setup", async () => {
    // The real `next` / `latest` shape: transform exists, the draft is
    // { list, get, update, remove }. Touching `add` here would throw inside the
    // host's batched reload flush and abort it before commit.
    let applied = false;
    const testContext = createContext({}, [], {
      command: {
        transform: async (apply) => {
          applied = true;
          apply({ list: () => [], get: () => undefined, update: () => {}, remove: () => {} });
          return { dispose: async () => {} };
        },
      },
    });

    await serverPlugin.setup(testContext.context as never);
    expect(applied).toBe(true);
    expect(testContext.getToolDefinition()?.name).toBe("submit_plan");
  });

  test("a rejecting command transform never fails plugin setup", async () => {
    // A slash command has a working markdown fallback; the whole Plannotator
    // integration going down for it would not.
    const testContext = createContext({}, [], {
      command: { transform: async () => { throw new Error("command domain unavailable"); } },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      await serverPlugin.setup(testContext.context as never);
    } finally {
      console.error = originalError;
    }
    expect(testContext.getToolDefinition()?.name).toBe("submit_plan");
  });

  test("registers slash commands even when submit_plan is disabled", async () => {
    // `workflow: "manual"` returns early before the tool registration, which is
    // exactly the mode that depends on the slash commands existing.
    const registered: string[] = [];
    const testContext = createContext({ workflow: "manual" }, [], {
      command: {
        transform: async (apply) => {
          apply({ add: (definition: { name: string }) => registered.push(definition.name) });
          return { dispose: async () => {} };
        },
      },
    });
    await serverPlugin.setup(testContext.context as never);

    expect(registered).toHaveLength(3);
    expect(testContext.getToolDefinition()).toBeUndefined();
  });

  test("reads a bare-array agent list, so subagent gating still applies", async () => {
    // Newer plugin hosts answer agent.list() with an array rather than the
    // `{ data }` envelope; reading `.data` blindly emptied the list and let
    // subagents keep submit_plan.
    delete process.env.PLANNOTATOR_ALLOW_SUBAGENTS;
    const testContext = createContext(
      { workflow: "all-agents" },
      [{ id: "researcher", mode: "subagent", hidden: false }],
      { agentListShape: "array" },
    );
    await serverPlugin.setup(testContext.context as never);
    const event = {
      agent: "researcher",
      system: [{ type: "text" as const, text: "Base system prompt" }],
      messages: [],
      tools: { submit_plan: { description: "Submit", input: {} } },
    };

    await testContext.getSessionContextHook()?.(event);
    expect(event.tools.submit_plan).toBeUndefined();
  });

  test("generic reminder composes into the existing part instead of pushing a second one", async () => {
    process.env.PLANNOTATOR_ALLOW_SUBAGENTS = "1";
    const testContext = createContext(
      { workflow: "all-agents" },
      [{ id: "helper", mode: "primary", hidden: false }],
    );
    await serverPlugin.setup(testContext.context as never);
    const event = {
      agent: "helper",
      system: [{ type: "text" as const, text: "Base system prompt" }],
      messages: [],
      tools: {
        submit_plan: { description: "Submit", input: {} },
      },
    };

    await testContext.getSessionContextHook()?.(event);
    // #1114: a second system part corrupts Qwen3.x Jinja templates.
    expect(event.system.length).toBe(1);
    expect(event.system[0]!.text).toContain("Base system prompt");
    expect(event.system[0]!.text).toContain("## Plan Submission");
    expect(event.system[0]!.text.indexOf("Base system prompt"))
      .toBeLessThan(event.system[0]!.text.indexOf("## Plan Submission"));
  });
});

describe("system part consolidation (#1114 regression class)", () => {
  // The bug class flagged in #1114's review: truncating the system array
  // BEFORE composing silently drops the host's entire system prompt. These
  // fail if either helper is reordered to `system.length = 0` first.

  test("replacePlanningSystemParts composes existing text before truncating", () => {
    const system = [
      { type: "text" as const, text: "Host base rules" },
      { type: "text" as const, text: "STRICTLY FORBIDDEN: ANY file edits.\nKeep plans concise." },
    ];
    replacePlanningSystemParts(system, ["## Plannotator planning prompt"]);
    expect(system.length).toBe(1);
    const text = system[0]!.text;
    // Pre-existing prompt text survives the consolidation (compose ran first).
    expect(text).toContain("Host base rules");
    expect(text).toContain("Keep plans concise.");
    expect(text).toContain("## Plannotator planning prompt");
    expect(text.indexOf("Host base rules")).toBeLessThan(text.indexOf("Keep plans concise."));
    expect(text.indexOf("Keep plans concise.")).toBeLessThan(text.indexOf("## Plannotator planning prompt"));
    // Conflicting plan-mode rules are still stripped.
    expect(text).not.toContain("STRICTLY FORBIDDEN");
  });

  test("pushComposedSystemReminder keeps prior parts' text before the reminder", () => {
    const system = [
      { type: "text" as const, text: "Host base rules" },
      { type: "text" as const, text: "Second host part" },
    ];
    pushComposedSystemReminder(system, "## Plan Submission reminder");
    expect(system.length).toBe(1);
    const text = system[0]!.text;
    expect(text).toContain("Host base rules");
    expect(text).toContain("Second host part");
    expect(text.endsWith("## Plan Submission reminder")).toBe(true);
    expect(text.indexOf("Host base rules")).toBeLessThan(text.indexOf("Second host part"));
  });
});

describe("V2 plan review URL delivery", () => {
  const SESSION_URL = "http://127.0.0.1:19432";

  // Regression: only the slash-command path was fixed at first. The plan path
  // builds its own client, so a remote reviewer who reached the review through
  // submit_plan still saw nothing: no browser is opened for them, and the
  // plugin's console output is discarded by the host.
  test("the embedded plan path posts the session URL as a transcript notice", async () => {
    const synthetic = mock(async (_input: unknown) => ({}));
    const client = createV2BridgeClient({
      ctx: { session: { synthetic } } as never,
      getAgents: async () => [],
      sessionID: "session-1",
    });

    createPlanReadyNotifier(client)(SESSION_URL);
    await Promise.resolve();

    expect(synthetic).toHaveBeenCalledTimes(1);
    expect(synthetic.mock.calls[0]![0]).toMatchObject({
      sessionID: "session-1",
      description: formatSessionUrlNotice(SESSION_URL),
      resume: false,
      // #1459: queue delivery keeps the notice out of steer-scoped promotion.
      delivery: "queue",
    });
  });

  // Regression: the fallback must stay SILENT, not fall back to app.log. That
  // is console.error, the same stderr handleServerReady has already printed the
  // URL to, so logging here would duplicate the line in remote mode and add a
  // stray one locally. This hook was empty for exactly that reason.
  test("without session.synthetic the plan path stays silent", () => {
    const log = mock((_entry: unknown) => {});
    const client = createV2BridgeClient({
      ctx: { session: {} },
      getAgents: async () => [],
      sessionID: "session-1",
    });
    client.app.log = log as never;

    expect(client.notifyUrl).toBeUndefined();
    expect(() => createPlanReadyNotifier(client)(SESSION_URL)).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });

  // Regression: the notifier tests above all pass while the plan path itself is
  // wired to nothing, which is exactly the shape the bug had. Reaching the real
  // wiring means running a plan review, so these two facts are pinned at source
  // level instead: without the session id the client can build no notifier, and
  // without the ready hook nothing ever calls it. Either one silently restores
  // the invisible URL with no other symptom.
  test("the plan path threads the session id and drives the ready hook", () => {
    const source = readFileSync(path.join(import.meta.dir, "server.ts"), "utf-8");

    // Booleans, not toMatch: a failing regex against a whole source file dumps
    // the file into the report and buries the one line that matters.
    expect(/sessionID:\s*toolContext\.sessionID/.test(source)).toBe(true);
    expect(/logReady:\s*createPlanReadyNotifier\(/.test(source)).toBe(true);
  });

  // Regression: a rejected notice must not surface as an unhandled rejection
  // and must not take the plan review down with it.
  test("a rejecting notice is caught", async () => {
    const client = createV2BridgeClient({
      ctx: { session: { synthetic: async () => { throw new Error("session gone"); } } } as never,
      getAgents: async () => [],
      sessionID: "session-1",
    });

    expect(() => createPlanReadyNotifier(client)(SESSION_URL)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
