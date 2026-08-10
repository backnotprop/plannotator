import { afterEach, describe, expect, mock, test } from "bun:test";
import serverPlugin, {
  pushComposedSystemReminder,
  replacePlanningSystemParts,
} from "./server";

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
) {
  let toolDefinition: Record<string, any> | undefined;
  let sessionContextHook: SessionContextHook | undefined;
  const sessionGet = mock(async () => ({ location: { directory: "/project" } }));

  return {
    context: {
      options,
      agent: {
        list: async () => ({ location: { directory: "/project" }, data: agents }),
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
