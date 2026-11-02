/**
 * Naming a thread the person started (approval "inbox-agent-names-own-thread"),
 * through the server's real doors: the wake asks the addressed session to name
 * it (`name_thread` on the bridge command, INBOX_NAME_THREAD_LINE in the wake),
 * MCP-only agents learn it from read_thread
 * (`name_this_thread: true` and the hint), send_message's result says when a
 * reply named it or did not, and compose takes a name the person gives
 * (`thread_name`), which no agent replaces and no wake asks about. Every test
 * runs its own Inbox under a temp data dir; connections are plain HTTP.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_NAME_THIS_THREAD_HINT, type InboxMessage, type InboxThread, type InboxListRow } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_POLL_PATH,
  INBOX_NAME_THREAD_LINE,
  INBOX_NEW_THREAD_INSTRUCTION,
  inboxWakeText,
  parseInboxBridgeCommands,
} from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-naming-")));
  roots.push(root);
  const project = join(root, "board-app");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-naming-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function poll(server: InboxServer, session: string, project: string) {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false }),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

function compose(server: InboxServer, body: Record<string, unknown>) {
  return fetch(`${base(server)}/api/inbox/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
}

async function thread(server: InboxServer, id: string): Promise<InboxThread & { row: InboxListRow }> {
  const body = (await (await fetch(`${base(server)}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread; row: InboxListRow };
  return { ...body.thread, row: body.row };
}

type ToolAnswer = { content: { type: string; text: string }[]; structuredContent: Record<string, unknown> };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as unknown as ToolAnswer;

const IDEA =
  "I want to explore what adding a board would look like. Kanban specifically. And the kanban needs to be well thought out, with a column for every state.";

describe("an agent names a thread the person started", () => {
  test("the wake asks the addressed session; a reply without a name says so; the first `thread` names it, once", async () => {
    const { server, client, project } = await setup();
    await poll(server, "ses-live", project);
    const sent = (await (await compose(server, { to: { session: "ses-live" }, body: IDEA, idempotency_key: "c1" })).json()) as { message: InboxMessage };
    expect(sent.message.subject).toBe("I want to explore what adding a board would look like");

    const [command] = await poll(server, "ses-live", project);
    expect(command).toMatchObject({ type: "message", new_thread: true, name_thread: true });
    const lines = inboxWakeText(command!).split("\n");
    expect(lines.slice(0, 3)).toEqual([`Plannotator Inbox: I want to explore what adding a board would look like (${sent.message.id})`, INBOX_NEW_THREAD_INSTRUCTION, INBOX_NAME_THREAD_LINE]);
    // An older connection that ignores the flag drops only that line.
    const { name_thread: _flag, ...older } = command!;
    expect(inboxWakeText(older)).not.toContain(INBOX_NAME_THREAD_LINE);

    // A reply with no name: the result says the thread can still be named.
    const first = await call(client, "send_message", { body: "On it.", reply_to: sent.message.id, project_path: project, agent_session: "ses-live", agent_host: "claude-code" });
    expect(first.content[0]!.text).toContain("still needs a name from you: pass `thread`");
    expect(first.structuredContent).toMatchObject({ name_this_thread: true, named_thread: null });
    expect(first.structuredContent.naming_refused).toBeUndefined();

    // read_thread (the caller may name it) carries the flag and the hint; another session's read does not.
    const read = await call(client, "read_thread", { thread_id: sent.message.id, agent_session: "ses-live" });
    expect(read.structuredContent.name_this_thread).toBe(true);
    expect(read.content[0]!.text).toContain(INBOX_NAME_THIS_THREAD_HINT);
    const other = await call(client, "read_thread", { thread_id: sent.message.id, agent_session: "ses-other" });
    expect(other.structuredContent.name_this_thread).toBeUndefined();

    // The first name sets the chip; the bold subject stays the short name.
    const named = await call(client, "send_message", {
      body: "Here is a first sketch.",
      reply_to: sent.message.id,
      thread: "Kanban board",
      project_path: project,
      agent_session: "ses-live",
      agent_host: "claude-code",
    });
    expect(named.content[0]!.text).toContain("Named this thread: Kanban board.");
    expect(named.structuredContent).toMatchObject({ named_thread: "Kanban board" });
    const opened = await thread(server, sent.message.id);
    expect(opened.thread_name).toBe("Kanban board");
    expect(opened.subject).toBe("I want to explore what adding a board would look like");
    expect(opened.row.thread_name).toBe("Kanban board");

    // Once: a later name is ignored and nothing mentions naming any more.
    const later = await call(client, "send_message", { body: "More.", reply_to: sent.message.id, thread: "Other", project_path: project, agent_session: "ses-live", agent_host: "claude-code" });
    expect(later.content[0]!.text).not.toContain("Named this thread");
    expect(later.structuredContent.name_this_thread).toBeUndefined();
    expect((await thread(server, sent.message.id)).thread_name).toBe("Kanban board");

    // The person's next reply wakes the agent without the naming line.
    const reply = await fetch(`${base(server)}/api/inbox/messages/${named.structuredContent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, words: "Looks good.", idempotency_key: "r1" }),
    });
    expect(reply.status).toBe(200);
    const next = await poll(server, "ses-live", project);
    const wake = next.find((c) => c.type === "reply")!;
    expect(wake.name_thread).toBeUndefined();
    expect(inboxWakeText(wake)).not.toContain(INBOX_NAME_THREAD_LINE);
  });

  test("an agent that reads later (MCP) gets the hint with the person's reply while the thread has no name", async () => {
    const { server, client, project } = await setup();
    await poll(server, "ses-live", project);
    const sent = (await (await compose(server, { to: { session: "ses-live" }, body: IDEA, idempotency_key: "c1" })).json()) as { message: InboxMessage };
    // The agent answers without a name; the person replies.
    const answer = await call(client, "send_message", { body: "Questions first: which columns?", reply_to: sent.message.id, project_path: project, agent_session: "ses-live", agent_host: "claude-code" });
    await fetch(`${base(server)}/api/inbox/messages/${answer.structuredContent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, words: "Todo, doing, done.", idempotency_key: "r1" }),
    });
    const got = await call(client, "read_thread", { thread_id: sent.message.id, agent_session: "ses-live" });
    expect(got.structuredContent).toMatchObject({ name_this_thread: true });
    expect(got.content[0]!.text).toContain(INBOX_NAME_THIS_THREAD_HINT);
  });

  test("a name the person gives in compose is the chip; no wake or result asks the agent to name it, and the agent cannot replace it", async () => {
    const { server, client, project } = await setup();
    await poll(server, "ses-live", project);
    const refused = await compose(server, { to: { session: "ses-live" }, body: IDEA, idempotency_key: "bad", thread_name: "line\nbreak" });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { code: string }).code).toBe("validation_error");

    const sent = (await (await compose(server, { to: { session: "ses-live" }, body: IDEA, idempotency_key: "c1", thread_name: "Board" })).json()) as { message: InboxMessage };
    expect(sent.message).toMatchObject({ thread_name: "Board", named_by: { kind: "person" } });
    const [command] = await poll(server, "ses-live", project);
    expect(command!.name_thread).toBeUndefined();
    expect(inboxWakeText(command!)).not.toContain(INBOX_NAME_THREAD_LINE);

    const answered = await call(client, "send_message", { body: "ok", reply_to: sent.message.id, thread: "Kanban", project_path: project, agent_session: "ses-live", agent_host: "claude-code" });
    expect(answered.content[0]!.text).not.toMatch(/Named this thread|still needs a name from you/);
    expect((await thread(server, sent.message.id)).thread_name).toBe("Board");

    // A name the person typed is the chip only: another session's send with it starts its own thread.
    const joined = await call(client, "send_message", { body: "elsewhere", thread: "board", project_path: project, agent_session: "ses-x", agent_host: "pi" });
    expect(joined.structuredContent.thread_id).not.toBe(sent.message.id);
  });

  test("a name another open thread has is refused, in the reply's result and in compose (409)", async () => {
    const { server, client, project } = await setup();
    // Session B already posts to "Auth refactor".
    const b = await call(client, "send_message", { body: "B's work", thread: "Auth refactor", project_path: project, agent_session: "ses-b", agent_host: "pi" });
    await poll(server, "ses-live", project);
    const sent = (await (await compose(server, { to: { session: "ses-live" }, body: IDEA, idempotency_key: "c1" })).json()) as { message: InboxMessage };

    const refused = await call(client, "send_message", { body: "ok", reply_to: sent.message.id, thread: "auth refactor", project_path: project, agent_session: "ses-live", agent_host: "claude-code" });
    expect(refused.structuredContent).toMatchObject({ named_thread: null, naming_refused: "thread_name_taken", name_this_thread: true });
    expect(refused.content[0]!.text).toContain("Pick another name and reply again with it in `thread`.");
    expect((await thread(server, sent.message.id)).thread_name ?? null).toBeNull();
    // B's next send still lands in B's thread.
    const again = await call(client, "send_message", { body: "B again", thread: "Auth refactor", project_path: project, agent_session: "ses-b", agent_host: "pi" });
    expect(again.structuredContent.thread_id).toBe(b.structuredContent.thread_id);

    const taken = await compose(server, { to: { session: "ses-live" }, body: "another idea", idempotency_key: "c2", thread_name: "AUTH REFACTOR" });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { code: string }).code).toBe("thread_name_taken");
  });

  test("a draft keeps the name the person typed", async () => {
    const { server } = await setup();
    const id = "drf_01M52F0YDDJYE865GBPNS86KXT";
    const saved = await fetch(`${base(server)}/api/inbox/drafts/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, body: IDEA, to: null, project: null, files: [], base: null, thread_name: "Kanban board" }),
    });
    expect(saved.status).toBe(200);
    const list = (await (await fetch(`${base(server)}/api/inbox/drafts`)).json()) as { drafts: { id: string; thread_name?: string }[] };
    expect(list.drafts.find((d) => d.id === id)?.thread_name).toBe("Kanban board");
  });
});
