import { afterEach, describe, expect, mock, test } from "bun:test";
import serverPlugin from "./server";

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

    expect(planningEvent.system.slice(0, 2).map((part) => part.text)).toEqual([
      "Base system prompt",
      "Earlier plugin prompt",
    ]);
    expect(planningEvent.system.some((part) => part.text.startsWith("## Plannotator"))).toBe(true);
    expect(planningEvent.system[0]?.metadata).toEqual({ source: "base" });
    expect(planningEvent.system[1]?.cache).toEqual({ type: "ephemeral" });
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
});
