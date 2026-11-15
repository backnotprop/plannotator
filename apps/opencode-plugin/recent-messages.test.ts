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
      user("u1", "Plan the migration"),
      assistant("step", [tool("read")]),
      compaction("c1"),
      synthetic("reminder", "<system-reminder>You are in Plan mode.</system-reminder>"),
      assistant("answer", [text("Here is the plan.")]),
    ])).toEqual(["answer", "earlier"]);
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
});

describe("pickRecentAssistantMessages on OpenCode 1", () => {
  test("a reply's parentID names its prompt; an all-synthetic prompt's reply does not open", () => {
    const picked = pickRecentAssistantMessages([
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "Explain the fix" }] },
      { info: { role: "assistant", id: "explanation", parentID: "u1", agent: "build", time: { created: 1_000 } }, parts: [{ type: "text", text: "Here is the fix" }] },
      { info: { role: "user", id: "s1" }, parts: [{ type: "text", text: "Wake", synthetic: true }] },
      { info: { role: "assistant", id: "ack", parentID: "s1" }, parts: [{ type: "text", text: "Done" }] },
    ]);
    expect(picked).toEqual([
      { messageId: "explanation", text: "Here is the fix", timestamp: new Date(1_000).toISOString(), agent: "build" },
      { messageId: "ack", text: "Done", timestamp: undefined },
    ]);
  });
});
