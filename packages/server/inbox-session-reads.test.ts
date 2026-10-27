/**
 * send_message's "not read since" line (the misfiled-thread AAR, 2026-10-27):
 * a session that writes into a thread it has not looked at for hours, or
 * ever, is told the thread's subject; the send itself always goes through.
 * And the connections' peek (the session's thread list after a compaction or
 * on a resume): it makes no project and does not count as a look.
 *
 * The failure each test catches: a session that remembered a wrong thread id
 * after a compaction files messages there with no signal (no line), a session
 * writing into its own fresh thread or answering the person's reply is nagged
 * (a line where none belongs, so agents learn to ignore it), or the
 * connection's own read hides the line for hours. Every test runs its own
 * Inbox under a temp data dir, with a clock the test moves.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, inboxSessionThreadsParams, inboxSessionThreadsText } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_THREAD_STALE_MS } from "./inbox-session-reads";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HOURS = 60 * 60 * 1000;

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reads-")));
  roots.push(root);
  const project = join(root, "app");
  mkdirSync(project, { recursive: true });
  const clock = { offset: 0 };
  const server = await startInboxServer({ dataDir: join(root, "data"), mcpNow: () => Date.now() + clock.offset });
  servers.push(server);
  const client = new Client({ name: "inbox-reads-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, root, later: (ms: number) => (clock.offset += ms) };
}

type ToolAnswer = { content: { type: string; text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as unknown as ToolAnswer;
const text = (answer: ToolAnswer) => answer.content.map((part) => part.text).join("\n");
const WARNING = /You have not read this thread/;

async function send(client: Client, project: string, session: string, args: Record<string, unknown>) {
  return call(client, "send_message", { project_path: project, agent_session: session, agent_host: "claude-code", ...args });
}

describe("send_message: the line naming a thread the session has not read", () => {
  test("another session's remembered id: the send lands, and the result names the thread's subject and name", async () => {
    const { client, project } = await setup();
    const root = await send(client, project, "ses-a", { body: "The context layer plan.", subject: "the context layer", thread: "Landing" });
    expect(text(root)).not.toMatch(WARNING);
    const misfiled = await send(client, project, "ses-b", { body: "Two more journey fixes are on staging.", reply_to: root.structuredContent.message_id });
    expect(misfiled.isError).toBeFalsy();
    expect(misfiled.structuredContent.thread_id).toBe(root.structuredContent.thread_id);
    expect(text(misfiled)).toContain('You have not read this thread in this session; its subject is "the context layer" (thread name "Landing").');
    expect(misfiled.structuredContent.not_read_since).toBeNull();
    // Joining it by its name names the thread too.
    const byName = await send(client, project, "ses-c", { body: "Another fix.", thread: "Landing" });
    expect(byName.structuredContent.thread_id).toBe(root.structuredContent.thread_id);
    expect(text(byName)).toMatch(WARNING);
  });

  test("the session's own thread: no line while it wrote there recently, the line once it has been away for hours", async () => {
    const { client, project, later } = await setup();
    const root = await send(client, project, "ses-a", { body: "Shipped the retry fix.", subject: "Retry fix" });
    const followUp = await send(client, project, "ses-a", { body: "Also the docs.", reply_to: root.structuredContent.message_id });
    expect(text(followUp)).not.toMatch(WARNING);
    // A default-routed follow-up (no reply_to) into the session's open thread: no line either.
    expect(text(await send(client, project, "ses-a", { body: "And the changelog." }))).not.toMatch(WARNING);
    later(INBOX_THREAD_STALE_MS + HOURS);
    // Routed by default (no reply_to, no thread): it goes where the session's own messages went, so no line.
    expect(text(await send(client, project, "ses-a", { body: "Back after lunch." }))).not.toMatch(/its subject is/);
    later(INBOX_THREAD_STALE_MS + HOURS);
    // Named by reply_to: the line, worded for the thread's starter, never "you have not read".
    const stale = await send(client, project, "ses-a", { body: "A journey fix.", reply_to: root.structuredContent.message_id });
    expect(text(stale)).toMatch(/You last wrote in this thread at \d{4}-\d\d-\d\d \d\d:\d\dZ; its subject is "Retry fix"\./);
    expect(text(stale)).not.toMatch(WARNING);
    expect(typeof stale.structuredContent.not_read_since).toBe("string");
  });

  test("read_thread, a list that showed the row, and wait_for_reply count as reads; the line then says since when", async () => {
    const { server, client, project, later } = await setup();
    const root = await send(client, project, "ses-a", { body: "Which columns?", subject: "Board columns" });
    const threadId = root.structuredContent.thread_id as string;

    await call(client, "read_thread", { thread_id: threadId, agent_session: "ses-b" });
    expect(text(await send(client, project, "ses-b", { body: "Columns: todo, doing, done.", reply_to: threadId }))).not.toMatch(WARNING);
    // A session that only read the thread, hours ago: the line says since when.
    await call(client, "read_thread", { thread_id: threadId, agent_session: "ses-d" });
    later(INBOX_THREAD_STALE_MS + HOURS);
    const stale = await send(client, project, "ses-d", { body: "Another note.", reply_to: threadId });
    expect(text(stale)).toMatch(/You have not read this thread since \d{4}-\d\d-\d\d \d\d:\d\dZ; its subject is "Board columns"\./);
    expect(typeof stale.structuredContent.not_read_since).toBe("string");

    // The list with no id (the check the rules ask for) counts for the rows it showed.
    later(INBOX_THREAD_STALE_MS + HOURS);
    const listed = await call(client, "read_thread", { project_path: project, agent_session: "ses-b", asked_by: "anyone" });
    expect(text(listed)).toContain(threadId);
    expect(text(await send(client, project, "ses-b", { body: "Checked the subject first.", reply_to: threadId }))).not.toMatch(WARNING);

    // wait_for_reply returning the person's reply counts too.
    later(INBOX_THREAD_STALE_MS + HOURS);
    const asked = await send(client, project, "ses-c", { body: "Ship it?", reply_to: threadId });
    expect(text(asked)).toMatch(WARNING);
    const waiting = call(client, "wait_for_reply", { thread_id: threadId, agent_session: "ses-c", timeout_seconds: 10 });
    await Bun.sleep(100);
    const reply = await fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${asked.structuredContent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, words: "Yes.", idempotency_key: "r1" }),
    });
    expect(reply.status).toBe(200);
    expect((await waiting).structuredContent.status).toBe("replied");
    expect(text(await send(client, project, "ses-c", { body: "Shipping.", reply_to: threadId }))).not.toMatch(WARNING);
  });

  test("a message the wake delivered counts as read: answering it raises no line, while the same answer to one never delivered does", async () => {
    const { server, client, project } = await setup();
    const at = (path: string, body: Record<string, unknown>, auth = true) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${server.token}` } : {}) },
        body: JSON.stringify(body),
      });
    const poll = () => at(INBOX_BRIDGE_POLL_PATH, { session: "ses-b", host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false });
    // The session is live (its bridge polls), so the person can write to it.
    expect((await poll()).status).toBe(200);
    const compose = async (key: string) => {
      const response = await at("/api/inbox/messages", { serverSession: server.serverSession, to: { session: "ses-b" }, body: `Please look at ${key}.`, idempotency_key: key }, false);
      expect(response.status).toBe(200);
      return ((await response.json()) as { message: { id: string } }).message.id;
    };
    const delivered = await compose("the-login-page");
    const notDelivered = await compose("the-billing-page");
    expect((await at(INBOX_BRIDGE_EVENT_PATH, { session: "ses-b", host: "claude-code", type: "delivered", id: delivered })).status).toBe(200);
    expect(text(await send(client, project, "ses-b", { body: "Looked: fine.", reply_to: delivered }))).not.toMatch(WARNING);
    expect(text(await send(client, project, "ses-b", { body: "Looked: fine.", reply_to: notDelivered }))).toMatch(WARNING);
  });

  test("no session, a new thread, or a replay: no line", async () => {
    const { client, project } = await setup();
    const root = await send(client, project, "ses-a", { body: "Plan.", subject: "Plan" });
    const anonymous = await call(client, "send_message", { project_path: project, body: "No session.", reply_to: root.structuredContent.message_id });
    expect(text(anonymous)).not.toMatch(WARNING);
    const first = await send(client, project, "ses-b", { body: "Into it.", reply_to: root.structuredContent.message_id, idempotency_key: "k1" });
    expect(text(first)).toMatch(WARNING);
    const replay = await send(client, project, "ses-b", { body: "Into it.", reply_to: root.structuredContent.message_id, idempotency_key: "k1" });
    expect(replay.structuredContent.replayed).toBe(true);
    expect(text(replay)).not.toMatch(WARNING);
  });
});

describe("the connections' peek (the session's thread list)", () => {
  test("health says this Inbox honours the peek mark (connections read the list only from one that does)", async () => {
    const { server } = await setup();
    const health = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).json()) as Record<string, unknown>;
    expect(health.peek).toBe(true);
  });

  test("lists the session's open threads as the list would, but does not count as a read", async () => {
    const { client, project } = await setup();
    const root = await send(client, project, "ses-a", { body: "Plan.", subject: "Plan", thread: "Plan" });
    const params = inboxSessionThreadsParams(project, "ses-b");
    const peek = await call(client, "read_thread", params.arguments as Record<string, unknown>, params._meta as Record<string, unknown>);
    // ses-b sent nothing: its own list is empty.
    expect(inboxSessionThreadsText(peek, "plannotator_inbox")).toBeNull();
    const own = inboxSessionThreadsParams(project, "ses-a");
    const listed = await call(client, "read_thread", own.arguments as Record<string, unknown>, own._meta as Record<string, unknown>);
    const lines = inboxSessionThreadsText(listed, "plannotator_inbox")!;
    expect(lines).toContain(`- ${root.structuredContent.thread_id} · "Plan" · name "Plan"`);
    // ses-b peeked at the project's list (asked_by anyone, as a connection never does, to prove the mark): still not a read.
    await call(client, "read_thread", { project_path: project, agent_session: "ses-b", asked_by: "anyone" }, params._meta as Record<string, unknown>);
    expect(text(await send(client, project, "ses-b", { body: "Into it.", reply_to: root.structuredContent.message_id }))).toMatch(WARNING);
  });

  test("a folder the Inbox has no project for: nothing listed, and no project made", async () => {
    const { server, client, root } = await setup();
    const elsewhere = join(root, "never-seen");
    mkdirSync(elsewhere, { recursive: true });
    const params = inboxSessionThreadsParams(elsewhere, "ses-a");
    const peek = await call(client, "read_thread", params.arguments as Record<string, unknown>, params._meta as Record<string, unknown>);
    expect(peek.isError).toBeFalsy();
    expect(inboxSessionThreadsText(peek, "plannotator_inbox")).toBeNull();
    expect(server.store.listProjects()).toHaveLength(0);
    // Without the mark the same list makes the project (as before): the mark is what keeps it out.
    await call(client, "read_thread", params.arguments as Record<string, unknown>);
    expect(server.store.listProjects()).toHaveLength(1);
  });
});
