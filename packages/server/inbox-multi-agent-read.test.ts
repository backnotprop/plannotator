/**
 * Two agent sessions in one thread (handoff "multi-agent-thread-model",
 * option A): only a plain reply's recipient settles it.
 *
 * The bug: the thread's agent-read mark was per thread, so ANY session's
 * read_thread settled a plain reply (no `to`, no tags). Claude Code asked,
 * the person replied while it was busy, Pi read the thread: the line said
 * "Delivered to Claude Code" and Claude Code's next poll was empty, so the
 * reply was lost (failure 1). A raw MCP agent's reply showed "Delivered"
 * after another session read, with no reader (failure 3). Now the mark never
 * moves past a reply still owed to another session, and the recipient's own
 * read past that point records the delivery, so its wake never repeats it.
 *
 * Except for a recipient no connection wakes, read by a session new to the
 * thread: a raw MCP client restarted gets a new shim `ses_` id, and its read
 * must still settle its reply (it used to stay "Saved for Cursor" for good).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_WAKES_META_KEY, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-multi-agent-")));
  roots.push(root);
  const project = join(root, "superfans");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-multi-agent-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

const CLAUDE = { host: "claude-code", name: "Claude Code", wakes: true };
const PI = { host: "pi", name: "Pi", wakes: true };
const CURSOR = { host: "cursor", name: "Cursor", wakes: false };

/** An agent's send (a reply in a thread with `replyTo`), through a waking connection or plain MCP; `session` null names none. */
async function agentSends(client: Client, project: string, session: string | null, who: { host: string; name: string; wakes: boolean }, body: string, replyTo?: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_host: who.host, agent_name: who.name, ...(session ? { agent_session: session } : {}), ...(replyTo ? { reply_to: replyTo } : {}) },
    ...(who.wakes ? { _meta: { [INBOX_WAKES_META_KEY]: true } } : {}),
  });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as { message_id: string; thread_id: string };
}

/** read_thread as `session` (null: a raw MCP read that names no session). */
async function reads(client: Client, threadId: string, session: string | null) {
  const result = await client.callTool({ name: "read_thread", arguments: { thread_id: threadId, ...(session ? { agent_session: session } : {}) } });
  expect(result.isError).toBeFalsy();
}

function bridge(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
}

/** What a connection's poll hands its session now: the reply ids. */
async function poll(server: InboxServer, session: string, host: string, project: string): Promise<string[]> {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, host, project_path: project, waitMs: 0, tags: true });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text()).map((c) => c.id);
}

async function delivered(server: InboxServer, session: string, host: string, id: string) {
  const response = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session, host, type: "delivered", id });
  expect(response.status).toBe(200);
}

/** The person's reply to `messageId` through the window's route (plain: no `to`, no tags). */
async function personReplies(server: InboxServer, messageId: string, words: string, key: string): Promise<string> {
  const response = await fetch(`${base(server)}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: key, words }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { reply: { id: string } }).reply.id;
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

async function row(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const list = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: InboxListRow[] }[] };
  return list.sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
}

describe("only a plain reply's recipient settles it", () => {
  test("failure 1: another session's read never swallows the reply; the asker's poll still has it, and the line is not Delivered", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-claude", CLAUDE, "Should the queue own retries?");
    const replyId = await personReplies(server, asked.message_id, "Yes, the queue.", "k1");

    // Pi, another session, reads the thread before Claude Code's connection takes the reply.
    await reads(client, asked.thread_id, "ses-pi");
    // Nor does a raw MCP read that names no session settle it.
    await reads(client, asked.thread_id, null);

    expect((await row(server, asked.thread_id)).sent?.checked_at ?? null).toBeNull();
    expect((await row(server, asked.thread_id)).section).toBe("sent");
    expect(await poll(server, "ses-claude", "claude-code", project)).toEqual([replyId]);
    await delivered(server, "ses-claude", "claude-code", replyId);
    expect((await row(server, asked.thread_id)).sent?.checked_at).toBeString();
    expect(await poll(server, "ses-claude", "claude-code", project)).toEqual([]);
  });

  test("failure 3: a raw MCP agent's reply is not Delivered when another session that wrote in the thread reads; its own read settles it", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-cursor", CURSOR, "Which region?");
    // Claude Code writes in the thread too: a second agent in it, not a newcomer.
    await agentSends(client, project, "ses-claude", CLAUDE, "I can take the deploy.", asked.message_id);
    await personReplies(server, asked.message_id, "us-east-1", "k1");

    await reads(client, asked.thread_id, "ses-claude");
    expect((await row(server, asked.thread_id)).sent?.checked_at ?? null).toBeNull();
    expect((await row(server, asked.thread_id)).delivery).toMatchObject({ state: "saved", host: "cursor" });

    await reads(client, asked.thread_id, "ses-cursor");
    expect((await row(server, asked.thread_id)).sent?.checked_at).toBeString();
    expect((await row(server, asked.thread_id)).delivery?.state).toBe("delivered");
  });

  test("a message sent without a session is settled by a read without one, never by the read of a session that wrote in the thread", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, null, CURSOR, "Which region?");
    await agentSends(client, project, "ses-claude", CLAUDE, "I can take the deploy.", asked.message_id);
    await personReplies(server, asked.message_id, "us-east-1", "k1");

    await reads(client, asked.thread_id, "ses-claude");
    expect((await row(server, asked.thread_id)).sent?.checked_at ?? null).toBeNull();
    await reads(client, asked.thread_id, null);
    expect((await row(server, asked.thread_id)).sent?.checked_at).toBeString();
  });

  test("a wake delivered to the last writer never settles an earlier reply owed to the first agent", async () => {
    const { server, client, project } = await setup();
    const first = await agentSends(client, project, "ses-claude", CLAUDE, "Should the queue own retries?");
    const toClaude = await personReplies(server, first.message_id, "Yes, the queue.", "k1");
    const second = await agentSends(client, project, "ses-pi", PI, "I raised the timeout.", first.message_id);
    expect(second.thread_id).toBe(first.thread_id);
    const toPi = await personReplies(server, second.message_id, "Thanks, ship it.", "k2");

    expect(await poll(server, "ses-pi", "pi", project)).toEqual([toPi]);
    await delivered(server, "ses-pi", "pi", toPi);
    // Pi's reply is Delivered (its own delivery), Claude Code's still waits for Claude Code.
    expect((await row(server, first.thread_id)).sent?.checked_at).toBeString();
    expect(await poll(server, "ses-claude", "claude-code", project)).toEqual([toClaude]);
  });

  test("the recipient's read past a reply owed to another session records the delivery, so its wake never repeats it", async () => {
    const { server, client, project } = await setup();
    const first = await agentSends(client, project, "ses-claude", CLAUDE, "Should the queue own retries?");
    const toClaude = await personReplies(server, first.message_id, "Yes, the queue.", "k1");
    const second = await agentSends(client, project, "ses-pi", PI, "I raised the timeout.", first.message_id);
    const toPi = await personReplies(server, second.message_id, "Thanks, ship it.", "k2");

    await reads(client, first.thread_id, "ses-pi");
    const after = await thread(server, first.thread_id);
    expect(after.messages.find((m) => m.id === toPi)?.delivery).toMatchObject({ state: "delivered", session: "ses-pi" });
    expect(after.messages.find((m) => m.id === toClaude)?.delivery ?? null).toBeNull();
    expect(await poll(server, "ses-pi", "pi", project)).toEqual([]);
    expect(await poll(server, "ses-claude", "claude-code", project)).toEqual([toClaude]);
    // Pi's reply is the last: the row says it reached Pi, by name.
    const delivery = (await row(server, first.thread_id)).delivery;
    expect(delivery).toMatchObject({ state: "delivered", host: "pi" });
  });
});

/** read_thread's list as `session` (every thread): the row of `threadId`'s `unread`. */
async function listedUnread(client: Client, project: string, session: string | null, threadId: string): Promise<boolean | undefined> {
  const list = await client.callTool({ name: "read_thread", arguments: { project_path: project, asked_by: "anyone", ...(session ? { agent_session: session } : {}) } });
  expect(list.isError).toBeFalsy();
  return (list.structuredContent as { threads: { thread_id: string; unread: boolean }[] }).threads.find((t) => t.thread_id === threadId)?.unread;
}

describe("a reader new to the thread, for a recipient no connection wakes", () => {
  test("a raw MCP agent restarted (a new shim ses_ id, the only agent): its read settles the reply", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses_shim_one", CURSOR, "Which region?");
    await personReplies(server, asked.message_id, "us-east-1", "k1");
    // The client restarted: a new shim process, a new ses_ id. The same agent reads the thread.
    await reads(client, asked.thread_id, "ses_shim_two");
    expect((await row(server, asked.thread_id)).sent?.checked_at ?? null).not.toBeNull();
    expect((await row(server, asked.thread_id)).delivery?.state).toBe("delivered");
    expect((await row(server, asked.thread_id)).section).not.toBe("sent");
    expect(await listedUnread(client, project, "ses_shim_two", asked.thread_id)).toBe(false);
  });

  test("an agent that names its session on send and none on read: its read settles the reply", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-script", CURSOR, "Which region?");
    await personReplies(server, asked.message_id, "us-east-1", "k1");
    await reads(client, asked.thread_id, null);
    expect((await row(server, asked.thread_id)).sent?.checked_at ?? null).not.toBeNull();
    expect((await row(server, asked.thread_id)).delivery?.state).toBe("delivered");
  });
});

describe("a read settles its reply past an earlier one still owed to a waking session", () => {
  // Claude Code (woken) asked and has not taken its reply; Cursor (raw MCP) wrote too and was answered.
  // The read mark stops at Claude Code's reply, so Cursor's read must settle Cursor's reply by itself.
  test("S1: Cursor restarted (a new shim ses_ id) reads: its reply is delivered and not unread, Claude Code's still waits", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-claude", CLAUDE, "Should the queue own retries?");
    const cursor = await agentSends(client, project, "ses_shim_one", CURSOR, "Which region for the queue?", asked.message_id);
    const toClaude = await personReplies(server, asked.message_id, "Yes, the queue.", "k1");
    const toCursor = await personReplies(server, cursor.message_id, "us-east-1", "k2");

    await reads(client, asked.thread_id, "ses_shim_two");
    const after = await thread(server, asked.thread_id);
    expect(after.messages.find((m) => m.id === toCursor)?.delivery).toMatchObject({ state: "delivered", host: "cursor" });
    expect(after.messages.find((m) => m.id === toClaude)?.delivery ?? null).toBeNull();
    expect((await row(server, asked.thread_id)).delivery).toMatchObject({ state: "delivered", host: "cursor" });
    expect(await listedUnread(client, project, "ses_shim_two", asked.thread_id)).toBe(false);
    expect(await poll(server, "ses-claude", "claude-code", project)).toEqual([toClaude]);
  });

  test("S1b: a client that names no session, sending and reading: its read settles its reply, Claude Code's still waits", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-claude", CLAUDE, "Should the queue own retries?");
    const cursor = await agentSends(client, project, null, CURSOR, "Which region for the queue?", asked.message_id);
    const toClaude = await personReplies(server, asked.message_id, "Yes, the queue.", "k1");
    const toCursor = await personReplies(server, cursor.message_id, "us-east-1", "k2");

    await reads(client, asked.thread_id, null);
    const after = await thread(server, asked.thread_id);
    expect(after.messages.find((m) => m.id === toCursor)?.delivery).toMatchObject({ state: "delivered", host: "cursor" });
    expect(after.messages.find((m) => m.id === toClaude)?.delivery ?? null).toBeNull();
    expect((await row(server, asked.thread_id)).delivery?.state).toBe("delivered");
    expect(await listedUnread(client, project, null, asked.thread_id)).toBe(false);
    expect(await poll(server, "ses-claude", "claude-code", project)).toEqual([toClaude]);
  });

  test("Pi, a participant, reads: Cursor's reply is not Pi's to settle, so it stays saved", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-claude", CLAUDE, "Should the queue own retries?");
    await agentSends(client, project, "ses-pi", PI, "I raised the timeout.", asked.message_id);
    const cursor = await agentSends(client, project, "ses_shim_one", CURSOR, "Which region for the queue?", asked.message_id);
    await personReplies(server, asked.message_id, "Yes, the queue.", "k1");
    const toCursor = await personReplies(server, cursor.message_id, "us-east-1", "k2");

    await reads(client, asked.thread_id, "ses-pi");
    expect((await thread(server, asked.thread_id)).messages.find((m) => m.id === toCursor)?.delivery ?? null).toBeNull();
    expect((await row(server, asked.thread_id)).delivery?.state).toBe("saved");
  });
});

describe("read_thread's unread follows what the caller's read settles", () => {
  test("another session's read: the reply owed to the asker is not 'unread' for the reader after it read", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-claude", CLAUDE, "Ship?");
    await personReplies(server, asked.message_id, "Yes.", "k1");
    await reads(client, asked.thread_id, "ses-pi");
    expect(await listedUnread(client, project, "ses-pi", asked.thread_id)).toBe(false);
    // The asker has not read it: unread for it.
    expect(await listedUnread(client, project, "ses-claude", asked.thread_id)).toBe(true);
  });

  test("after /clear: the new session reads its own reply, and the old session's reply leaves it not 'unread'", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-old", CLAUDE, "Should the queue own retries?");
    const toOld = await personReplies(server, asked.message_id, "Yes, the queue.", "k1");
    // /clear: a new session of the same agent writes in the thread, and the person answers it.
    const again = await agentSends(client, project, "ses-new", CLAUDE, "Picking this up after a clear: retries in the queue?", asked.message_id);
    const toNew = await personReplies(server, again.message_id, "Yes, as I said.", "k2");
    expect(await listedUnread(client, project, "ses-new", asked.thread_id)).toBe(true);

    await reads(client, asked.thread_id, "ses-new");
    const after = await thread(server, asked.thread_id);
    expect(after.messages.find((m) => m.id === toNew)?.delivery).toMatchObject({ state: "delivered", session: "ses-new" });
    expect(after.messages.find((m) => m.id === toOld)?.delivery ?? null).toBeNull();
    expect(await listedUnread(client, project, "ses-new", asked.thread_id)).toBe(false);
  });
});

describe("a thread with one agent behaves as before", () => {
  test("its own read settles the reply through the read mark, records no delivery, and its poll is empty", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-claude", CLAUDE, "Should the queue own retries?");
    const replyId = await personReplies(server, asked.message_id, "Yes, the queue.", "k1");
    await reads(client, asked.thread_id, "ses-claude");

    const read = await thread(server, asked.thread_id);
    expect(read.messages.find((m) => m.id === replyId)?.delivery ?? null).toBeNull();
    expect(read.messages[0]!.agent_checked_seq).toBe(read.messages.find((m) => m.id === replyId)!.seq);
    const listed = await row(server, asked.thread_id);
    expect(listed.sent?.checked_at).toBe(read.messages[0]!.agent_checked_at!);
    expect(listed.delivery).toMatchObject({ state: "delivered", host: "claude-code" });
    expect(await poll(server, "ses-claude", "claude-code", project)).toEqual([]);
  });

  test("an agent that names no session, sending and reading: its read settles its reply", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, null, CURSOR, "Which region?");
    await personReplies(server, asked.message_id, "us-east-1", "k1");
    await reads(client, asked.thread_id, null);
    expect((await row(server, asked.thread_id)).sent?.checked_at).toBeString();
  });
});

describe("who settled a reply no connection wakes", () => {
  const lineOf = async (server: InboxServer, threadId: string) => {
    const delivery = (await row(server, threadId)).delivery!;
    return { read_by: delivery.read_by ?? null, state: delivery.state };
  };

  test("another agent's read: still settled, and the row names who read it, so it never claims the agent it was for took it", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "cursor-1", CURSOR, "Which region?");
    // A session of another host, new to this thread; it wrote elsewhere, so the Inbox knows what it is.
    const other = join(project, "..", "elsewhere");
    mkdirSync(other, { recursive: true });
    await agentSends(client, other, "ses_claude", CLAUDE, "Unrelated.");
    await personReplies(server, asked.message_id, "us-east-1", "k1");
    await reads(client, asked.thread_id, "ses_claude");
    expect(await lineOf(server, asked.thread_id)).toEqual({ read_by: "claude-code", state: "delivered" });
    // Another read changes nothing, but the agent it was for reading it does: it has it now.
    await reads(client, asked.thread_id, "ses_never_seen");
    expect((await lineOf(server, asked.thread_id)).read_by).toBe("claude-code");
    await reads(client, asked.thread_id, "cursor-1");
    expect((await lineOf(server, asked.thread_id)).read_by).toBeNull();
  });

  test("hosts are free text: one the Inbox has no name for, asking or reading, or one spelled two ways, never gets a name", async () => {
    const { server, client, project } = await setup();
    const elsewhere = join(project, "..", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    await agentSends(client, elsewhere, "ses_lower", CURSOR, "Unrelated.");
    await agentSends(client, elsewhere, "ses_mystery", { host: "mystery-agent", name: "Mystery", wakes: false }, "Unrelated.");
    await agentSends(client, elsewhere, "ses_claude", CLAUDE, "Unrelated.");

    // The asker wrote its host another way: the same agent, so never "Read by Cursor" on a reply to Cursor.
    const spelled = await agentSends(client, project, "cursor-caps", { host: "Cursor", name: "Cursor", wakes: false }, "Which region?");
    await personReplies(server, spelled.message_id, "us-east-1", "k1");
    await reads(client, spelled.thread_id, "ses_lower");
    expect(await lineOf(server, spelled.thread_id)).toEqual({ read_by: null, state: "delivered" });

    // A host the Inbox cannot name read it: no line can say who.
    const asked = await agentSends(client, project, "cursor-1", CURSOR, "Which zone?");
    await personReplies(server, asked.message_id, "a", "k2");
    await reads(client, asked.thread_id, "ses_mystery");
    expect(await lineOf(server, asked.thread_id)).toEqual({ read_by: null, state: "delivered" });
    // And a known agent reading a reply to an unknown host: the same, by the asker's side of the rule.
    const unknown = await agentSends(client, project, "ses_other", { host: "mystery-agent", name: "Mystery", wakes: false }, "Which rack?");
    await personReplies(server, unknown.message_id, "r1", "k3");
    await reads(client, unknown.thread_id, "ses_claude");
    expect(await lineOf(server, unknown.thread_id)).toEqual({ read_by: null, state: "delivered" });
  });

  test("two ids of one agent are one agent: `claude` and `claude-code` never read as someone else", async () => {
    const { server, client, project } = await setup();
    const elsewhere = join(project, "..", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    await agentSends(client, elsewhere, "ses_code", CLAUDE, "Unrelated.");
    const asked = await agentSends(client, project, "ses_claude_old", { host: "claude", name: "Claude Code", wakes: false }, "Which region?");
    await personReplies(server, asked.message_id, "us-east-1", "k1");
    await reads(client, asked.thread_id, "ses_code");
    expect(await lineOf(server, asked.thread_id)).toEqual({ read_by: null, state: "delivered" });
  });

  test("a reader that only polls is known by its connection: the row names it", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "cursor-1", CURSOR, "Which region?");
    await poll(server, "ses_pi_quiet", "pi", project);
    await personReplies(server, asked.message_id, "us-east-1", "k1");
    await reads(client, asked.thread_id, "ses_pi_quiet");
    expect(await lineOf(server, asked.thread_id)).toEqual({ read_by: "pi", state: "delivered" });
  });

  test("a reply addressed to a session is that session's: another agent reading it is no one's read", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "cursor-1", CURSOR, "Which region?");
    const elsewhere = join(project, "..", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    await agentSends(client, elsewhere, "ses_claude", CLAUDE, "Unrelated.");
    await poll(server, "ses_pi", "pi", project);
    const response = await fetch(`${base(server)}/api/inbox/messages/${asked.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "k1", words: "us-east-1", to: { host: "pi", session: "ses_pi" } }),
    });
    expect(response.status).toBe(200);
    await reads(client, asked.thread_id, "ses_claude");
    expect((await lineOf(server, asked.thread_id)).read_by).toBeNull();
    expect((await thread(server, asked.thread_id)).messages[0]!.agent_checked_by ?? null).toBeNull();
  });

  test("the agent it was for: no name, the line stays Delivered", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "cursor-1", CURSOR, "Which region?");
    await personReplies(server, asked.message_id, "us-east-1", "k1");
    await reads(client, asked.thread_id, "cursor-1");
    expect(await lineOf(server, asked.thread_id)).toEqual({ read_by: null, state: "delivered" });
  });

  test("a new session id of the same host may be that agent restarted, and an unknown one may too: no name", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "cursor-1", CURSOR, "Which region?");
    await personReplies(server, asked.message_id, "us-east-1", "k1");
    await reads(client, asked.thread_id, "ses_never_seen");
    expect(await lineOf(server, asked.thread_id)).toEqual({ read_by: null, state: "delivered" });

    const again = await agentSends(client, project, "cursor-2", CURSOR, "And which zone?", undefined);
    const elsewhere = join(project, "..", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    await agentSends(client, elsewhere, "cursor-3", CURSOR, "Unrelated.");
    await personReplies(server, again.message_id, "a", "k2");
    await reads(client, again.thread_id, "cursor-3");
    expect(await lineOf(server, again.thread_id)).toEqual({ read_by: null, state: "delivered" });
  });

  test("a reply to a waking session is never settled by another read, so it never says who read it", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses_pi", PI, "Which region?");
    const elsewhere = join(project, "..", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    await agentSends(client, elsewhere, "ses_claude", CLAUDE, "Unrelated.");
    await personReplies(server, asked.message_id, "us-east-1", "k1");
    await reads(client, asked.thread_id, "ses_claude");
    expect((await lineOf(server, asked.thread_id)).read_by).toBeNull();
    expect((await row(server, asked.thread_id)).delivery?.state).not.toBe("delivered");
  });

  test("past a reply still owed to a waking session: the settled one still names its reader", async () => {
    const { server, client, project } = await setup();
    const first = await agentSends(client, project, "ses_pi", PI, "Pi asks.");
    const second = await agentSends(client, project, "cursor-1", CURSOR, "Cursor asks.", first.message_id);
    await personReplies(server, first.message_id, "To Pi.", "k1");
    await personReplies(server, second.message_id, "To Cursor.", "k2");
    const elsewhere = join(project, "..", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    await agentSends(client, elsewhere, "ses_claude", CLAUDE, "Unrelated.");
    await reads(client, first.thread_id, "ses_claude");
    expect((await thread(server, first.thread_id)).messages.at(-1)?.delivery?.read_by).toBe("claude-code");
    expect((await lineOf(server, first.thread_id)).read_by).toBe("claude-code");
  });
});
