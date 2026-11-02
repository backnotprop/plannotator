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

  test("failure 3: a raw MCP agent's reply is not Delivered when another session reads; its own read settles it", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-cursor", CURSOR, "Which region?");
    await personReplies(server, asked.message_id, "us-east-1", "k1");

    await reads(client, asked.thread_id, "ses-claude");
    expect((await row(server, asked.thread_id)).sent?.checked_at ?? null).toBeNull();
    expect((await row(server, asked.thread_id)).delivery?.state).toBe("saved");

    await reads(client, asked.thread_id, "ses-cursor");
    expect((await row(server, asked.thread_id)).sent?.checked_at).toBeString();
    expect((await row(server, asked.thread_id)).delivery?.state).toBe("delivered");
  });

  test("a message sent without a session is settled by a read without one, never by a session's read", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, null, CURSOR, "Which region?");
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
