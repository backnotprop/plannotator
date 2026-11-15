import { describe, expect, test } from "bun:test";
import { pickRecentAssistantMessages } from "./recent-messages";
import { toBridgeMessages } from "./v2-client";

// OpenCode 2 rows as `ctx.session.context()` returns them
// (`SessionMessage` in @opencode-ai/sdk v2), read through the same
// translation the bridge uses.
let clock = 0;
const user = (id: string, text: string) => ({ id, type: "user", time: { created: ++clock }, text });
const synthetic = (id: string, text: string) => ({ id, type: "synthetic", time: { created: ++clock }, sessionID: "s", text });
const compaction = (id: string) => ({ id, type: "compaction", reason: "auto", summary: "", recent: "", time: { created: ++clock } });
const tool = (name: string, output = "") => ({
  type: "tool",
  id: `call-${name}-${clock}`,
  name,
  state: { status: "completed", input: {}, content: [{ type: "text", text: output }], structured: {} },
  time: { created: clock },
});
const text = (value: string) => ({ type: "text", id: `t-${clock}`, text: value });
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "p", id: "m" },
  time: { created: ++clock, completed: clock },
  content,
  finish: content.some((part) => (part as { type: string }).type === "tool") ? "tool-calls" : "stop",
  ...extra,
});

const pickV2 = (rows: unknown[], limit?: number) =>
  pickRecentAssistantMessages(toBridgeMessages(rows), limit).map(({ messageId }) => messageId);

describe("pickRecentAssistantMessages on OpenCode 2", () => {
  test("Plannotator's session-URL notice inside the person's turn keeps that turn's answer first", () => {
    expect(pickV2([
      user("u0", "Summarize the plan"),
      assistant("earlier", [text("Earlier summary")]),
      user("u1", "Open notes.md in Plannotator"),
      assistant("launch", [text("Opening it."), tool("plannotator")]),
      synthetic("notice", "Plannotator session ready: http://localhost:1"),
      assistant("answer", [text("It is open; your feedback comes back here.")]),
    ])).toEqual(["answer", "launch", "earlier"]);
  });

  test("the Plan-mode reminder re-added after the person's prompt keeps the answer first", () => {
    const earlier = [user("u0", "What does the job do?"), assistant("earlier", [text("It syncs the tables.")])];
    expect(pickV2([
      ...earlier,
      user("u1", "Plan the migration"),
      synthetic("reminder", "<system-reminder>You are in Plan mode.</system-reminder>"),
      assistant("answer", [text("Here is the plan.")]),
    ])).toEqual(["answer", "earlier"]);

    expect(pickV2([
      ...earlier,
      user("u1", "Now build it"),
      synthetic("leave", "<system-reminder>\nYou are NO LONGER in Plan mode. The previous Plan restrictions no longer apply.\n</system-reminder>"),
      assistant("answer", [text("Built it.")]),
    ])).toEqual(["answer", "earlier"]);

    expect(pickV2([
      ...earlier,
      user("u1", "Plan the migration"),
      assistant("step", [tool("read")]),
      compaction("c1"),
      synthetic("reminder", "<system-reminder>You are in Plan mode.</system-reminder>"),
      assistant("answer", [text("Here is the plan.")]),
    ])).toEqual(["answer", "earlier"]);
  });

  test("a compaction at the start of the person's turn counts as the turn running", () => {
    expect(pickV2([
      user("u0", "Q"),
      assistant("a0", [text("A")]),
      user("u1", "Plan the migration"),
      compaction("c1"),
      synthetic("cont", "Continue if you have next steps"),
      assistant("answer", [text("Here is the plan.")]),
    ])).toEqual(["answer", "a0"]);
  });

  test("a reply to a plugin-injected prompt does not open, and the rest stay newest first", () => {
    expect(pickV2([
      user("u0", "First question"),
      assistant("older", [text("Older answer")]),
      user("u1", "Explain the fix"),
      assistant("explanation", [text("Here is the fix")]),
      synthetic("wake", "Background task finished"),
      assistant("status", [text("Background task done")]),
    ])).toEqual(["explanation", "status", "older"]);
  });

  test("an injected prompt after a failed step starts its own turn", () => {
    expect(pickV2([
      user("u1", "Run the tests"),
      assistant("partial", [text("Running them"), tool("bash")], { finish: undefined, error: { name: "Aborted" } }),
      synthetic("wake", "Background task finished"),
      assistant("status", [text("Done")]),
    ])).toEqual(["partial", "status"]);
  });

  test("skips tool-only and empty replies, and lists no subagent result as a message", () => {
    expect(pickV2([
      user("u1", "Review the module"),
      assistant("delegate", [tool("task", "Subagent report: three issues")]),
      assistant("blank", [text("   ")]),
      assistant("answer", [text("Three issues, listed below.")]),
    ])).toEqual(["answer"]);
  });

  test("only replies to injected prompts: the newest opens", () => {
    expect(pickV2([
      synthetic("w1", "Wake"),
      assistant("first", [text("First")]),
      synthetic("w2", "Wake"),
      assistant("second", [text("Second")]),
    ])).toEqual(["second", "first"]);
  });

  test("the limit keeps the reply that opens, even when it is older than the rest", () => {
    expect(pickV2([
      user("u1", "Explain the fix"),
      assistant("explanation", [text("Here is the fix")]),
      synthetic("w1", "Wake"),
      assistant("s1", [text("Status 1")]),
      synthetic("w2", "Wake"),
      assistant("s2", [text("Status 2")]),
    ], 2)).toEqual(["explanation", "s2"]);
  });

  // The `subagent` tool's background answer and its later result, as OpenCode 2
  // stores them (`tool/plugin/subagent.ts` backgroundResult, `SubagentCompletion.deliver`).
  const startBackground = (child: string) => ({
    ...tool("subagent", `The subagent is working in the background (sessionID: ${child}).`),
    state: {
      status: "completed",
      input: { description: "review", prompt: "Review the module", background: true },
      content: [{ type: "text", text: `The subagent is working in the background (sessionID: ${child}).` }],
      structured: { sessionID: child, status: "running" },
    },
  });
  const subagentResult = (id: string, child: string, value: string) =>
    synthetic(id, `<subagent sessionID="${child}" state="completed" description="review">\n${value}\n</subagent>`);

  test("the reply to a background subagent the person's turn started opens", () => {
    expect(pickV2([
      user("u0", "Q"),
      assistant("a0", [text("A")]),
      user("u1", "Review the module in the background"),
      assistant("launch", [startBackground("ses_child1")]),
      assistant("started", [text("A reviewer is working on it in the background.")]),
      subagentResult("r1", "ses_child1", "Three issues."),
      assistant("report", [text("The reviewer found three issues.")]),
    ])).toEqual(["report", "started", "a0"]);
  });

  test("a subagent result stays behind when a wake's turn started it, or nothing here did", () => {
    expect(pickV2([
      user("u1", "Explain the fix"),
      assistant("explanation", [text("Here is the fix")]),
      synthetic("wake", "Background task finished"),
      assistant("launch", [startBackground("ses_child2")]),
      assistant("ack", [text("Started a follow-up.")]),
      subagentResult("r2", "ses_child2", "Done."),
      assistant("followup", [text("Follow-up done.")]),
      subagentResult("r3", "ses_unknown", "Done."),
      assistant("other", [text("Other result noted.")]),
    ])).toEqual(["explanation", "other", "followup", "ack"]);
  });

  test("a final step that used only a provider-hosted tool ends the turn, so a later wake is its own", () => {
    expect(pickV2([
      user("u1", "Search the web for X"),
      assistant("answer", [{ ...tool("web_search"), provider: { executed: true } }, text("Here is what I found.")], { finish: "stop" }),
      synthetic("wake", "Background task finished"),
      assistant("status", [text("Background task done")]),
    ])).toEqual(["answer", "status"]);
  });

  test("a reply cut at the output limit and its continuation: the continuation opens", () => {
    expect(pickV2([
      user("u0", "Q"),
      assistant("a0", [text("A")]),
      user("u1", "Write the long doc"),
      assistant("part1", [text("First half...")], { finish: "length" }),
      synthetic("cont", "Continue from where you left off"),
      assistant("part2", [text("...second half")]),
    ])).toEqual(["part2", "part1", "a0"]);
  });

  test("a prompt that got no reply, then a wake: the person's previous answer opens", () => {
    expect(pickV2([
      user("u0", "Q"),
      assistant("a0", [text("A")]),
      user("u1", "never answered"),
      synthetic("wake", "Background task finished"),
      assistant("status", [text("Done")]),
    ])).toEqual(["a0", "status"]);
  });

  test("several notices in one turn, after an injected first message, keep the turn's answer first", () => {
    expect(pickV2([
      synthetic("first", "Background task finished"),
      assistant("ack", [text("Noted")]),
      user("u1", "Do it"),
      assistant("s1", [tool("plannotator")]),
      synthetic("n1", "Plannotator session ready: http://localhost:1"),
      assistant("s2", [tool("read")]),
      synthetic("n2", "<system-reminder>You are in Plan mode.</system-reminder>"),
      assistant("answer", [text("Done it")]),
    ])).toEqual(["answer", "ack"]);
  });
});

describe("pickRecentAssistantMessages on OpenCode 1", () => {
  // OpenCode 1 rows as `client.session.messages()` returns them: `info` plus `parts`.
  const prompt = (id: string, value: string) => ({ info: { role: "user", id }, parts: [{ type: "text", text: value }] });
  const injected = (id: string, value: string) => ({ info: { role: "user", id }, parts: [{ type: "text", text: value, synthetic: true }] });
  const reply = (id: string, parentID: string, value: string, extra: Record<string, unknown> = {}) =>
    ({ info: { role: "assistant", id, parentID, finish: "stop", ...extra }, parts: [{ type: "text", text: value }] });
  const toolStep = (id: string, parentID: string, name: string) =>
    ({ info: { role: "assistant", id, parentID, finish: "tool-calls" }, parts: [{ type: "tool", tool: name }] });
  const pickV1 = (rows: unknown[]) => pickRecentAssistantMessages(rows).map(({ messageId }) => messageId);

  test("an all-synthetic prompt's reply does not open, and keeps its id, text and agent", () => {
    const picked = pickRecentAssistantMessages([
      prompt("u1", "Explain the fix"),
      { info: { role: "assistant", id: "explanation", parentID: "u1", agent: "build", time: { created: 1_000 } }, parts: [{ type: "text", text: "Here is the fix" }] },
      injected("s1", "Wake"),
      { info: { role: "assistant", id: "ack", parentID: "s1" }, parts: [{ type: "text", text: "Done" }] },
    ]);
    expect(picked).toEqual([
      { messageId: "explanation", text: "Here is the fix", timestamp: new Date(1_000).toISOString(), agent: "build" },
      { messageId: "ack", text: "Done", timestamp: undefined },
    ]);
  });

  test("a reply whose parentID names the person's prompt is theirs, even after an injected row", () => {
    expect(pickV1([
      prompt("u0", "Q"),
      reply("a0", "u0", "A"),
      prompt("u1", "Explain the fix"),
      injected("s1", "Background task finished"),
      reply("explanation", "u1", "Here is the fix"),
    ])).toEqual(["explanation", "a0"]);
  });

  test("auto-compaction inside the person's turn: the turn's answer opens, never the summary", () => {
    expect(pickV1([
      prompt("u0", "Earlier"),
      reply("earlier", "u0", "Earlier answer"),
      prompt("u1", "Refactor the module"),
      toolStep("step", "u1", "edit"),
      { info: { role: "user", id: "cu" }, parts: [{ type: "compaction", auto: true }] },
      reply("summary", "cu", "## Goal\nSummary of the conversation so far", { summary: true, agent: "compaction", mode: "compaction" }),
      { info: { role: "user", id: "cont" }, parts: [{ type: "text", synthetic: true, text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.", metadata: { compaction_continue: true } }] },
      reply("final", "cont", "Refactor done."),
    ])).toEqual(["final", "summary", "earlier"]);
  });

  test("a manual compaction after the turn: its summary is listed but does not open", () => {
    expect(pickV1([
      prompt("u1", "Explain the fix"),
      reply("explanation", "u1", "Here is the fix"),
      { info: { role: "user", id: "cu" }, parts: [{ type: "compaction", auto: false }] },
      reply("summary", "cu", "## Goal\nSummary", { summary: true, agent: "compaction", mode: "compaction" }),
    ])).toEqual(["explanation", "summary"]);
  });

  test("a subtask command: its answer opens, after the synthetic summarize row", () => {
    expect(pickV1([
      prompt("u0", "Earlier"),
      reply("earlier", "u0", "Earlier answer"),
      { info: { role: "user", id: "u1" }, parts: [{ type: "subtask", agent: "general", prompt: "review", description: "review" }] },
      toolStep("task", "u1", "task"),
      injected("su", "Summarize the task tool output above and continue with your task."),
      reply("final", "su", "Review: three issues"),
    ])).toEqual(["final", "earlier"]);
  });

  test("a step that used only a provider-hosted tool ends the turn", () => {
    expect(pickV1([
      prompt("u1", "Search the web"),
      { info: { role: "assistant", id: "answer", parentID: "u1", finish: "stop" }, parts: [{ type: "tool", tool: "web_search", metadata: { providerExecuted: true } }, { type: "text", text: "Found it." }] },
      injected("wake", "Background task finished"),
      reply("status", "wake", "Done"),
    ])).toEqual(["answer", "status"]);
  });
});
