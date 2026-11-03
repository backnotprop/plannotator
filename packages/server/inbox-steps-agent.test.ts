/**
 * Thread steps for agents (approval "inbox-thread-steps", 2026-11-03) on a
 * real Inbox, config.json deciding the switch.
 *
 * Off (the default), agents get nothing, and that is proved here for every
 * host's tool text: the Claude Code mod's builder (its contract copy), the
 * shared builder Pi, OpenCode and DeepSeek Harness use (with the wake, and
 * without it for OpenCode 1), and a raw MCP client's tools/list and server
 * instructions. Each is byte for byte the text built from the bundled
 * default list (INBOX_DEFAULT_TOOLS, which predates steps), and none holds
 * the word. No wake line, no compaction line, no read_thread lines either,
 * though the store keeps a list. A `steps` call from a session that listed
 * it while on answers steps_off; a send_message that still carries `steps`
 * is sent without them.
 *
 * On: the approved text word for word (pinned on purpose: the owner approved
 * it exactly), the action and the field write the session's list, read_thread
 * shows it, the compaction list says "steps 2/5", a reply's wake carries the
 * approved line, and the entry stays within 5% of the size the window states.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_TOOL_COST_STEPS, type InboxAuthor } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_POLL_PATH,
  INBOX_STEPS_LEAD,
  inboxAgentTool,
  inboxSessionThreadsText,
  inboxWakeText,
  parseInboxBridgeCommands,
  parseInboxToolList,
} from "@plannotator/shared/inbox/connection";
import { inboxAgentTool as modAgentTool } from "../../apps/hook/hooks/mod/inbox-contract";
import { INBOX_DEFAULT_TOOLS } from "../../apps/hook/hooks/mod/inbox-default-tools";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_MCP_INSTRUCTIONS } from "./inbox-mcp";

/** The approved agent text, exact (approval "inbox-thread-steps", item 7). Pinned on purpose. */
const APPROVED =
  "steps: your plan for the work in this thread, as the person should see it: 3 to 8 short steps, the whole list each call (it replaces the last one). status: todo, doing, done, waiting (on the person), dropped (say why in note). Call it when a step starts or ends; it sends nothing and notifies no one. Skip it for work that ends in this reply.";
const APPROVED_WAKE = "Your steps here: 2 of 5 done; doing: Replay the failures in staging. Update them if that changed.";

/** The word as an agent would read it: `steps` alone, not inside `diff_steps`. */
const STEPS_WORD = /(?<![A-Za-z_])steps(?![A-Za-z_])/i;

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const PLAN = [
  { step: "Classify failed charges", status: "done" },
  { step: "Retry worker on pg-boss", status: "done" },
  { step: "Replay the failures in staging", status: "doing", note: "38 of 40 recovered" },
  { step: "Ship it behind a flag", status: "waiting" },
  { step: "Admin retry view", status: "todo" },
  { step: "Retry Stripe 409s", status: "dropped", note: "Stripe settles them" },
];

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> };

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-checklist-agent-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const project = join(root, "app");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return JSON.parse(data ? data.slice(5) : text) as { result: any };
  };
  const tools = async () => parseInboxToolList((await rpc("tools/list", {})).result);
  const rawList = async () => JSON.stringify((await rpc("tools/list", {})).result);
  const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result as ToolResult;
  const agent = { agent_session: "ses_a", agent_host: "claude-code", agent_name: "Claude Code" };
  const setSteps = (on: boolean) =>
    fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps: { on } }) });
  const sent = await call("send_message", { ...agent, project_path: project, body: "Retry worker plan.", subject: "Retry worker" });
  const thread = sent.structuredContent!.thread_id as string;
  const firstMessage = sent.structuredContent!.message_id as string;
  const author: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };
  const poll = async () => {
    const response = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: "ses_a", host: "claude-code", project_path: project, waitMs: 0 }),
    });
    return parseInboxBridgeCommands(await response.text());
  };
  const personReplies = (body: string) =>
    fetch(`${base}/api/inbox/messages/${firstMessage}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k-${body}`, words: body }) });
  const list = async () => (await call("read_thread", { agent_session: "ses_a", project_path: project, limit: 5 })) as ToolResult;
  return { server, base, project, thread, author, rpc, tools, rawList, call, agent, setSteps, poll, personReplies, list };
}

describe("off, the default: agents get nothing", () => {
  test("every host's tool text is the bundled pre-steps text, with no word of steps", async () => {
    const w = await world();
    const served = await w.tools();
    expect(JSON.parse(JSON.stringify(served))).toEqual(JSON.parse(JSON.stringify(INBOX_DEFAULT_TOOLS)));
    const hosts = {
      "claude-code (mod)": modAgentTool(served),
      "pi, opencode 2, dsh": inboxAgentTool(served),
      "opencode 1 (no wake)": inboxAgentTool(served, { wakes: false }),
    };
    const baseline = {
      "claude-code (mod)": modAgentTool(INBOX_DEFAULT_TOOLS),
      "pi, opencode 2, dsh": inboxAgentTool(INBOX_DEFAULT_TOOLS),
      "opencode 1 (no wake)": inboxAgentTool(INBOX_DEFAULT_TOOLS, { wakes: false }),
    };
    for (const [host, tool] of Object.entries(hosts)) {
      const text = JSON.stringify({ description: tool!.description, schema: tool!.inputSchema });
      expect({ host, text }).toEqual({ host, text: JSON.stringify({ description: baseline[host as keyof typeof baseline]!.description, schema: baseline[host as keyof typeof baseline]!.inputSchema }) });
      expect({ host, word: STEPS_WORD.test(text) }).toEqual({ host, word: false });
    }
    // A raw MCP client (Codex, Cursor, any stdio client): the list as served, and the server's instructions.
    expect(STEPS_WORD.test(await w.rawList())).toBe(false);
    const init = (await w.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result;
    expect(init.instructions).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(STEPS_WORD.test(init.instructions)).toBe(false);
  });

  test("a list in the store adds no wake, compaction or read_thread line", async () => {
    const w = await world();
    w.server.store.setThreadSteps({ thread_id: w.thread, agent: w.author, steps: PLAN });
    expect((await w.personReplies("Go ahead.")).status).toBe(200);
    const [command] = await w.poll();
    expect(command!.steps).toBeUndefined();
    expect(STEPS_WORD.test(inboxWakeText(command!))).toBe(false);
    const listed = await w.list();
    expect(STEPS_WORD.test(inboxSessionThreadsText(listed) ?? "")).toBe(false);
    expect(STEPS_WORD.test(JSON.stringify(listed))).toBe(false);
    const read = await w.call("read_thread", { agent_session: "ses_a", thread_id: w.thread });
    expect(STEPS_WORD.test(read.content[0]!.text)).toBe(false);
    expect(read.structuredContent!.steps).toBeUndefined();
  });

  test("a steps call from a session that listed it while on writes nothing; a send that carries steps still goes", async () => {
    const w = await world();
    const refused = await w.call("steps", { ...w.agent, thread_id: w.thread, steps: PLAN });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toStartWith("steps_off: ");
    const sent = await w.call("send_message", { ...w.agent, project_path: w.project, reply_to: w.thread, body: "Replay done.", steps: PLAN });
    expect(sent.isError).toBeFalsy();
    expect(w.server.store.threadSteps(w.thread)).toEqual([]);
  });
});

describe("on", () => {
  test("the action is the approved text, and the action and the field each write the session's list", async () => {
    const w = await world();
    await w.setSteps(true);
    const served = await w.tools();
    expect(served.map((tool) => tool.name)).toContain("steps");
    expect(served.find((tool) => tool.name === "steps")!.description).toBe(INBOX_STEPS_LEAD);
    for (const tool of [inboxAgentTool(served)!, modAgentTool(served)!]) expect(tool.description.split("\n")).toContain(`- ${APPROVED}`);

    const saved = await w.call("steps", { ...w.agent, thread_id: w.thread, steps: PLAN });
    expect(saved.isError).toBeFalsy();
    expect(saved.content[0]!.text).toContain("2 of 5 done; doing: Replay the failures in staging");
    expect(w.server.store.stepsOf(w.thread, "ses_a")!.steps).toHaveLength(6);

    const next = PLAN.map((s) => (s.status === "doing" ? { step: s.step, status: "done" } : s));
    const sent = await w.call("send_message", { ...w.agent, project_path: w.project, reply_to: w.thread, body: "Replay done.", steps: next });
    expect(sent.content[0]!.text).toContain("Steps saved: 3 of 5 done.");
    expect(w.server.store.stepsOf(w.thread, "ses_a")!.steps[2]!.status).toBe("done");
  });

  test("past the limits nothing is sent and nothing is written", async () => {
    const w = await world();
    await w.setSteps(true);
    const before = w.server.store.cursor();
    const long = await w.call("send_message", { ...w.agent, project_path: w.project, reply_to: w.thread, body: "x", steps: [{ step: "s".repeat(81), status: "todo" }] });
    expect(long.isError).toBe(true);
    const many = await w.call("steps", { ...w.agent, thread_id: w.thread, steps: Array.from({ length: 13 }, (_, i) => ({ step: `s${i}`, status: "todo" })) });
    expect(many.isError).toBe(true);
    expect(w.server.store.cursor()).toBe(before);
  });

  test("read_thread shows the list; the compaction list says steps 2/5; a reply's wake carries the approved line", async () => {
    const w = await world();
    await w.setSteps(true);
    await w.call("steps", { ...w.agent, thread_id: w.thread, steps: PLAN });
    const read = await w.call("read_thread", { agent_session: "ses_a", thread_id: w.thread });
    expect(read.content[0]!.text).toContain("Your steps (2 of 5 done; doing: Replay the failures in staging;");
    expect(read.content[0]!.text).toContain("- dropped: Retry Stripe 409s · Stripe settles them");
    expect(inboxSessionThreadsText(await w.list())).toContain("steps 2/5");

    expect((await w.personReplies("Ship it.")).status).toBe(200);
    const [command] = await w.poll();
    expect(command!.steps).toEqual({ done: 2, total: 5, doing: "Replay the failures in staging" });
    const wake = inboxWakeText(command!);
    expect(wake).toContain(`\n\n${APPROVED_WAKE}\n\n[thread ${w.thread}`);
  });

  test("the entry with steps on stays within 5% of the size the window states", async () => {
    const w = await world();
    const size = (tool: ReturnType<typeof inboxAgentTool>) => Buffer.byteLength(JSON.stringify({ name: tool!.name, description: tool!.description, parameters: tool!.inputSchema }));
    const off = size(inboxAgentTool(await w.tools()));
    await w.setSteps(true);
    const added = size(inboxAgentTool(await w.tools())) - off;
    expect(Math.abs(added - INBOX_TOOL_COST_STEPS.bytes) / INBOX_TOOL_COST_STEPS.bytes).toBeLessThanOrEqual(0.05);
  });
});
