import { afterEach, describe, expect, mock, test } from "bun:test";
import serverPlugin, {
  addInboxBriefing,
  createPlanReadyNotifier,
  pushComposedSystemReminder,
  replacePlanningSystemParts,
} from "./server";
import { INBOX_COMMAND_BRIEFING } from "@plannotator/shared/inbox/connection";
import { commandFailureNoticeText, createInboxBriefings, createV2BridgeClient, dropSessionUrlNotices, formatCommandFailureNotice, formatInboxNotice, formatSessionUrlNotice, inboxNoticeText } from "./v2-client";
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
    command?: { transform: (apply: (draft: any) => void) => Promise<unknown> };
    agentListShape?: "envelope" | "array";
  } = {},
) {
  let toolDefinition: Record<string, any> | undefined;
  let sessionContextHook: SessionContextHook | undefined;
  const contextHooks: SessionContextHook[] = [];
  const generateHooks: SessionContextHook[] = [];
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
          if (name === "context") {
            sessionContextHook = callback;
            contextHooks.push(callback);
          }
          if (name === "generate") generateHooks.push(callback);
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
    runContextHooks: async (event: Parameters<SessionContextHook>[0]) => {
      for (const hook of contextHooks) await hook(event);
    },
    runGenerateHooks: async (event: Parameters<SessionContextHook>[0]) => {
      for (const hook of generateHooks) await hook(event);
    },
    sessionGet,
  };
}

describe("OpenCode V2 server plugin", () => {
  test("exports a stable V2 plugin object", () => {
    expect(serverPlugin.id).toBe("plannotator");
    expect(serverPlugin.setup).toBeInstanceOf(Function);
  });

  for (const workflow of ["plan-agent", "all-agents", "manual"] as const) {
    test(`${workflow}: setup completes on a context without session or tool domains`, async () => {
      await expect(serverPlugin.setup({ options: { workflow } } as never)).resolves.toBeUndefined();
    });
  }

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

  test("rewrites OpenCode 2's Plan mode reminder in the plan agent's history so the model submits with submit_plan (#2101)", async () => {
    const enter = `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
/home/dev/.opencode/plan

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`;
    const testContext = createContext({ workflow: "plan-agent" });
    await serverPlugin.setup(testContext.context as never);
    const request = () => ({
      agent: "plan",
      system: [{ type: "text" as const, text: "Base system prompt" }],
      messages: [
        { role: "user", content: [{ type: "text", text: enter }] },
        { role: "user", content: [{ type: "text", text: "Create an execution plan for the cache." }] },
      ] as unknown[],
      tools: { submit_plan: { description: "Submit", input: {} } },
    });
    const first = request();
    await testContext.runContextHooks(first);
    const reminder = (first.messages[0] as { content: Array<{ text: string }> }).content[0]!.text;
    expect(reminder).toContain("submit it with the submit_plan tool");
    expect(reminder).not.toContain("Discuss the plan with the user directly");
    expect((first.messages[1] as { content: Array<{ text: string }> }).content[0]!.text).toBe("Create an execution plan for the cache.");
    expect(first.tools.submit_plan).toBeDefined();
    expect(first.system[0]!.text).toContain("## Plannotator");

    const second = request();
    await testContext.runContextHooks(second);
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));

    const build = { ...request(), agent: "build" };
    await testContext.runContextHooks(build);
    expect((build.messages[0] as { content: Array<{ text: string }> }).content[0]!.text).toBe(enter);
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
      "plannotator-inbox",
    ]);

    const withoutCommands = createContext();
    await serverPlugin.setup(withoutCommands.context as never);
    expect(withoutCommands.getToolDefinition()?.name).toBe("submit_plan");
  });

  test("a pre-#44765 command draft registers nothing and does not fail setup", async () => {
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

    expect(registered).toHaveLength(4);
    expect(testContext.getToolDefinition()).toBeUndefined();
  });

  test("reads a bare-array agent list, so subagent gating still applies", async () => {
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
    expect(event.system.length).toBe(1);
    expect(event.system[0]!.text).toContain("Base system prompt");
    expect(event.system[0]!.text).toContain("## Plan Submission");
    expect(event.system[0]!.text.indexOf("Base system prompt"))
      .toBeLessThan(event.system[0]!.text.indexOf("## Plan Submission"));
  });
});

describe("system part consolidation (#1114 regression class)", () => {
  test("replacePlanningSystemParts composes existing text before truncating", () => {
    const system = [
      { type: "text" as const, text: "Host base rules" },
      { type: "text" as const, text: "STRICTLY FORBIDDEN: ANY file edits.\nKeep plans concise." },
    ];
    replacePlanningSystemParts(system, ["## Plannotator planning prompt"]);
    expect(system.length).toBe(1);
    const text = system[0]!.text;
    expect(text).toContain("Host base rules");
    expect(text).toContain("Keep plans concise.");
    expect(text).toContain("## Plannotator planning prompt");
    expect(text.indexOf("Host base rules")).toBeLessThan(text.indexOf("Keep plans concise."));
    expect(text.indexOf("Keep plans concise.")).toBeLessThan(text.indexOf("## Plannotator planning prompt"));
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
      delivery: "steer",
    });
  });

  test("without session.synthetic the plan path logs the URL once", () => {
    const log = mock((_entry: unknown) => {});
    const client = createV2BridgeClient({
      ctx: { session: {} },
      getAgents: async () => [],
      sessionID: "session-1",
    });
    client.app.log = log as never;

    expect(client.notifyUrl).toBeUndefined();
    expect(() => createPlanReadyNotifier(client)(SESSION_URL)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toEqual({ level: "info", message: formatSessionUrlNotice(SESSION_URL) });
  });

  test("the plan path threads the session id and drives the ready hook", () => {
    const source = readFileSync(path.join(import.meta.dir, "server.ts"), "utf-8");

    expect(/sessionID:\s*toolContext\.sessionID/.test(source)).toBe(true);
    expect(/logReady:\s*createPlanReadyNotifier\(/.test(source)).toBe(true);
  });

  test("the plan path releases the notice watch when the review ends", () => {
    const source = readFileSync(path.join(import.meta.dir, "server.ts"), "utf-8");

    expect(/\}\s*finally\s*\{[^}]*client\.dispose\(\);/.test(source)).toBe(true);
  });

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

describe("session-URL notices stay out of the model context", () => {
  const notice = (url = "http://localhost:19432") => ({ role: "user", content: [{ type: "text", text: formatSessionUrlNotice(url) }] });
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  const toolResult = (text: string) => ({ role: "tool", content: [{ type: "tool-result", id: "call_1", name: "submit_plan", result: { type: "text", value: text } }] });

  test("a notice promoted after the decision is dropped, so the decision is read last", () => {
    const messages: unknown[] = [
      user("make a plan"),
      assistant("calling submit_plan"),
      toolResult("YOUR PLAN WAS NOT APPROVED."),
      user("<system-reminder>plan mode</system-reminder>"),
      notice(),
    ];

    expect(dropSessionUrlNotices(messages)).toBe(1);
    expect(messages).toEqual([
      user("make a plan"),
      assistant("calling submit_plan"),
      toolResult("YOUR PLAN WAS NOT APPROVED."),
      user("<system-reminder>plan mode</system-reminder>"),
    ]);
  });

  test("older notices in history and notices beside feedback are dropped too", () => {
    const messages: unknown[] = [notice("http://localhost:1"), user("q"), assistant("a"), notice("http://localhost:2"), user("# Code Review Feedback")];
    expect(dropSessionUrlNotices(messages)).toBe(2);
    expect(messages).toEqual([user("q"), assistant("a"), user("# Code Review Feedback")]);
  });

  test("a lone notice after the model's reply is kept rather than ending the request on the assistant", () => {
    const messages: unknown[] = [user("q"), assistant("a"), notice()];
    expect(dropSessionUrlNotices(messages)).toBe(0);
    expect(messages).toHaveLength(3);
  });

  test("a slash command's failure notice is dropped like the URL notice", () => {
    const failure = user(commandFailureNoticeText("plannotator-annotate", "File not found: nothere.md"));
    const messages: unknown[] = [user("q"), assistant("a"), failure, user("annotate notes.md instead")];
    expect(dropSessionUrlNotices(messages)).toBe(1);
    expect(messages).toEqual([user("q"), assistant("a"), user("annotate notes.md instead")]);
  });

  test("/plannotator-inbox's notice and failure notice are dropped; a pasted copy of the address line is not", () => {
    const opened = user(inboxNoticeText("http://localhost:61234/", "No browser opened: this is a remote session."));
    const failed = user(commandFailureNoticeText("plannotator-inbox", "The plannotator on PATH is older than /plannotator-inbox."));
    const pasted = user(`${formatInboxNotice("http://localhost:61234/")} is this right?`);
    const messages: unknown[] = [user("q"), assistant("a"), opened, failed, pasted];
    expect(dropSessionUrlNotices(messages)).toBe(2);
    expect(messages).toEqual([user("q"), assistant("a"), pasted]);
  });

  test("a typed or pasted copy of the failure line is never dropped", () => {
    const seen = formatCommandFailureNotice("plannotator-annotate", "File not found: nothere.md");
    const messages: unknown[] = [user(seen), assistant("a"), user(`${seen}\n\nwhy?`), assistant("b"), user("next")];
    expect(dropSessionUrlNotices(messages)).toBe(0);
    expect(messages).toHaveLength(5);
  });

  test("text that only resembles a notice is left alone", () => {
    const messages: unknown[] = [
      user("Plannotator session ready: http://localhost:1 — what is this?"),
      { role: "assistant", content: [{ type: "text", text: formatSessionUrlNotice("http://localhost:1") }] },
      { role: "user", content: [{ type: "text", text: formatSessionUrlNotice("http://localhost:1") }, { type: "text", text: "more" }] },
    ];
    expect(dropSessionUrlNotices(messages)).toBe(0);
  });

  for (const workflow of ["plan-agent", "manual"] as const) {
    test(`${workflow}: the plugin filters every model request`, async () => {
      const testContext = createContext({ workflow });
      await serverPlugin.setup(testContext.context as never);
      const event = {
        agent: "build",
        system: [{ type: "text" as const, text: "system" }],
        messages: [user("q"), assistant("calling"), toolResult("Plan approved!"), notice()] as unknown[],
        tools: {},
      };

      await testContext.runContextHooks(event);

      expect(event.messages).toEqual([user("q"), assistant("calling"), toolResult("Plan approved!")]);
    });
  }

  test("session.generate requests (plan review quick answers) are filtered too", async () => {
    const testContext = createContext({ workflow: "plan-agent" });
    await serverPlugin.setup(testContext.context as never);
    const event = {
      agent: "plan",
      system: [{ type: "text" as const, text: "system" }],
      messages: [user("make a plan"), assistant("calling submit_plan"), notice(), user("[Plannotator Ask AI] why step 2?")] as unknown[],
      tools: {},
    };

    await testContext.runGenerateHooks(event);

    expect(event.messages).toEqual([user("make a plan"), assistant("calling submit_plan"), user("[Plannotator Ask AI] why step 2?")]);
  });
});

describe("OpenCode 2 /plannotator-inbox briefing", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
  const agents = async () => [{ name: "build", mode: "primary" }, { name: "explore", mode: "subagent" }] as never;
  const request = (sessionID: string, agent = "build", messages: unknown[] = [user("next")]) => ({
    sessionID,
    agent,
    system: [{ type: "text" as const, text: "You are OpenCode." }],
    messages,
  });
  const count = (event: { system: Array<{ text: string }> }) => event.system.map((part) => part.text).join("\n").split(INBOX_COMMAND_BRIEFING).length - 1;

  test("a session that opened the Inbox carries the briefing once on each request; another session does not", async () => {
    const briefings = createInboxBriefings();
    const before = request("ses_1");
    await addInboxBriefing(before, briefings, agents);
    expect(count(before)).toBe(0);

    briefings.mark("ses_1");
    const after = request("ses_1");
    await addInboxBriefing(after, briefings, agents);
    await addInboxBriefing(after, briefings, agents);
    expect(count(after)).toBe(1);

    const other = request("ses_2");
    await addInboxBriefing(other, briefings, agents);
    expect(count(other)).toBe(0);
  });

  test("the command's notice in the session marks it too (after a restart); a subagent never gets it", async () => {
    const briefings = createInboxBriefings();
    const resumed = request("ses_3", "build", [user(inboxNoticeText("http://localhost:61234/")), user("next")]);
    await addInboxBriefing(resumed, briefings, agents);
    expect(count(resumed)).toBe(1);

    briefings.mark("ses_4");
    const sub = request("ses_4", "explore");
    await addInboxBriefing(sub, briefings, agents);
    expect(count(sub)).toBe(0);
  });

  test("wired into the plugin's context hook: read before the notice is dropped from the request", async () => {
    const testContext = createContext({ workflow: "manual" });
    await serverPlugin.setup(testContext.context as never);
    const event = { ...request("ses_5", "build", [user(inboxNoticeText("http://localhost:61234/")), user("next")]), tools: {} };
    await testContext.runContextHooks(event as never);
    expect(count(event)).toBe(1);
    expect(event.messages).toEqual([user("next")]);
  });
});
