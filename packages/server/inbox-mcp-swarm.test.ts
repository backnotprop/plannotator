/**
 * The `swarm` action (inbox-mcp-swarm.ts) and its view (inbox-swarm-view.ts), run through the tool's own handler on a
 * real store in a temp folder. The failures these guard: a line one agent says that another agent's read does not
 * show; a message id that is not read as its thread; the caller not told which line is its own; a line kept as a
 * message (it would wake agents and move cursors); an id on a linked computer answered as "no thread"; and a member
 * whose live state or computer the view drops.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { InboxAgent, InboxAgentsGroup, InboxAuthor, InboxTag } from "@plannotator/core/inbox-types";
import type { InboxSwarmMember } from "@plannotator/core/inbox-swarm";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxSwarms } from "@plannotator/shared/inbox/swarms";
import { registerInboxSwarmTool, type InboxSwarmMcpContext } from "./inbox-mcp-swarm";
import { createInboxSwarmView } from "./inbox-swarm-view";
import { agentMessage, messageText } from "./inbox-mcp-read";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: { thread_id: string; on: boolean; members: InboxSwarmMember[]; saved?: string } };

const CLAUDE: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_cc", name: "Claude Code" };
const AS_CLAUDE = { agent_session: "ses_cc", agent_host: "claude-code", agent_name: "Claude Code" };
const AS_PI = { agent_session: "ses_pi", agent_host: "pi", agent_name: "Pi" };

function agent(session: string, host: string, more: Partial<InboxAgent> = {}): InboxAgent {
  return { id: session, session, host, project: { id: null, name: "billing" }, state: "idle", waiting: 0, live: true, started_at: null, last_seen_at: null, ...more };
}

function world(options: { groups?: () => InboxAgentsGroup[]; far?: (id: string) => string | null; machineName?: (id: string) => string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-mcp-swarm-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const swarms = new InboxSwarms(store.dir);
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const tags = [{ host: "pi", session: "ses_pi", wakes: true }] as unknown as InboxTag[];
  const root = store.startPersonThread({ project_id: project.id, body: "Split the retry work between you.", to: { host: "claude-code", session: "ses_cc" }, idempotency_key: "k-1", tags, swarm: true }).message;
  swarms.setOn(root.thread_id, true);
  const reply = store.sendMessage({ project_id: project.id, author: CLAUDE, body: "On it.", reply_to: root.id }).message;
  const view = createInboxSwarmView({ store, swarms, agents: options.groups, selfMachine: () => "ibx_self", machineName: options.machineName });
  const context: InboxSwarmMcpContext = { store, swarms, swarmView: view.swarmViewOf, farThreadMachine: options.far };
  let handler: ((input: Record<string, unknown>) => Promise<Result>) | null = null;
  const fake = { registerTool: (_name: string, _config: unknown, run: typeof handler) => (handler = run) } as unknown as McpServer;
  registerInboxSwarmTool(fake, context);
  return { store, swarms, root, reply, view, call: (input: Record<string, unknown>) => handler!(input) };
}

const textOf = (result: Result) => result.content.map((c) => c.text).join("\n");

describe("the swarm action", () => {
  test("one agent's line, said with a message id of the thread, is in another agent's view; the caller's own line is marked", async () => {
    const w = world();
    const before = w.store.thread(w.root.thread_id)!.messages.length;
    const said = await w.call({ thread_id: w.reply.id, doing: "Writing the retry worker", ...AS_CLAUDE });
    expect(said.isError).toBeUndefined();
    expect(said.structuredContent!.thread_id).toBe(w.root.thread_id);
    expect(said.structuredContent!.saved).toBe("Writing the retry worker");

    const seen = await w.call({ thread_id: w.root.thread_id, ...AS_PI });
    expect(seen.isError).toBeUndefined();
    const { on, members } = seen.structuredContent!;
    expect(on).toBe(true);
    expect(members.map((m) => m.session)).toEqual(["ses_cc", "ses_pi"]);
    expect(members[0]!.doing?.text).toBe("Writing the retry worker");
    expect(members[1]!.doing).toBeNull();
    expect(seen.structuredContent!.saved).toBeUndefined();
    // "(you)" marks the caller's line, and only it.
    const lines = textOf(seen).split("\n").filter((line) => line.startsWith("- "));
    expect(lines.filter((line) => line.includes("(you)"))).toEqual([lines[1]!]);
    expect(lines[0]).toContain("Writing the retry worker");
    // Kept in the swarm record, never as a message.
    expect(w.store.thread(w.root.thread_id)!.messages.length).toBe(before);
    expect(new InboxSwarms(w.store.dir).get(w.root.thread_id)?.doing.map((d) => d.session)).toEqual(["ses_cc"]);
  });

  test("a new line replaces the agent's last; an empty doing only looks", async () => {
    const w = world();
    await w.call({ thread_id: w.root.thread_id, doing: "Reading the queue code", ...AS_CLAUDE });
    await w.call({ thread_id: w.root.thread_id, doing: "Writing tests", ...AS_CLAUDE });
    const looked = await w.call({ thread_id: w.root.thread_id, doing: "  ", ...AS_CLAUDE });
    expect(looked.isError).toBeUndefined();
    expect(looked.structuredContent!.members[0]!.doing?.text).toBe("Writing tests");
  });

  test("a line from a call that names no session is refused, and nothing is kept", async () => {
    const w = world();
    const result = await w.call({ thread_id: w.root.thread_id, doing: "Writing the retry worker" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toStartWith("validation_error:");
    expect(w.swarms.get(w.root.thread_id)?.doing).toEqual([]);
  });

  test("works on a thread that is not a swarm: the result says it is off", async () => {
    const w = world();
    w.swarms.setOn(w.root.thread_id, false);
    const result = await w.call({ thread_id: w.root.thread_id, doing: "Reviewing", ...AS_PI });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent!.on).toBe(false);
    expect(result.structuredContent!.members.find((m) => m.session === "ses_pi")?.doing?.text).toBe("Reviewing");
  });

  test("an id this Inbox does not hold: a linked computer's thread is named as there, any other is not found", async () => {
    const w = world({ far: (id) => (id === "msg_01K7FARTHREAD0000000000000" ? "Studio Mac" : null) });
    const far = await w.call({ thread_id: "msg_01K7FARTHREAD0000000000000", ...AS_PI });
    expect(far.isError).toBe(true);
    expect(textOf(far)).toStartWith("thread_on_other_machine:");
    const none = await w.call({ thread_id: "msg_01K7NOSUCHTHREAD000000000", ...AS_PI });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toStartWith("thread_not_found:");
  });
});

describe("the swarm view", () => {
  test("each member's state comes from the agents list; one the full list does not name has ended; a linked computer's agent says where", () => {
    const groups = (): InboxAgentsGroup[] => [
      { agents: [agent("ses_cc", "claude-code", { state: "working", label: "Retry worker" })], total: 1, ended_today: 0 },
      { machine: "ibx_far", agents: [agent("ses_pi", "pi")], total: 1, ended_today: 0 },
    ];
    const w = world({ groups, machineName: (id) => (id === "ibx_far" ? "Studio Mac" : null) });
    const members = w.view.swarmViewOf(w.root.thread_id)!.members;
    expect(members[0]).toMatchObject({ session: "ses_cc", name: "Retry worker", state: "working", machine: null, where: "billing" });
    expect(members[1]).toMatchObject({ session: "ses_pi", name: "Pi", machine: "ibx_far", where: "billing · Studio Mac" });

    const gone = world({ groups: () => [{ agents: [], total: 0, ended_today: 0 }] });
    expect(gone.view.swarmViewOf(gone.root.thread_id)!.members.map((m) => m.state)).toEqual(["ended", "ended"]);
  });

  test("a session that said a line without being in the thread is shown with it", async () => {
    const w = world();
    await w.call({ thread_id: w.root.thread_id, doing: "Watching the deploy", agent_session: "ses_cx", agent_host: "codex" });
    const members = w.view.swarmViewOf(w.root.thread_id)!.members;
    expect(members.map((m) => m.session)).toEqual(["ses_cc", "ses_pi", "ses_cx"]);
    expect(members[2]!.doing?.text).toBe("Watching the deploy");
  });
});

describe("read_thread of a swarm thread's first message", () => {
  test("carries the swarm block naming the other agents for the reader, and a reply carries none", () => {
    const w = world();
    const thread = w.store.thread(w.root.thread_id)!;
    const root = thread.messages.find((m) => m.id === w.root.id)!;
    const asClaude = agentMessage(root, "whole", "ses_cc");
    expect(asClaude.swarm_start).toContain(w.root.thread_id);
    expect(asClaude.swarm_start).toContain("Pi");
    expect(asClaude.swarm_start).not.toContain("Claude Code");
    expect(agentMessage(root, "whole", "ses_pi").swarm_start).toContain("Claude Code");
    const shown = messageText(asClaude, { previousId: null, previousDate: null, rootId: w.root.id });
    expect(shown).toContain(asClaude.swarm_start!);
    const reply = thread.messages.find((m) => m.id === w.reply.id)!;
    expect(agentMessage(reply, "whole", "ses_pi").swarm_start).toBeUndefined();
  });
});
