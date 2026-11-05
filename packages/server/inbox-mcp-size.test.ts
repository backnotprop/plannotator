/**
 * How big the Inbox's MCP results are, on a long seeded thread (an agent
 * asks, the person answers, 30 rounds: 59 messages), through the real doors:
 * a running Inbox, the MCP SDK client, and the text the agent connections
 * hand the model (`inboxToolResultText`). The failures these guard: a host
 * that indents the structured JSON again, read_thread's list carrying the
 * window's full records again, and a message id passed as
 * `thread` starting a new thread named after it. The thread window, the
 * text-complete mark and search are in inbox-mcp-window.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { inboxToolResultText } from "@plannotator/shared/inbox/connection";
import { seedLongThread } from "../../tests/helpers/inbox-long-thread";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

async function world(rounds = 30, options: { setAsideDelayMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-mcp-size-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), ...options });
  servers.push(server);
  const client = new Client({ name: "inbox-mcp-size-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const seeded = await seedLongThread({ client, port: server.port, project, rounds });
  return { project, server, client, seeded };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  const result = (await client.callTool({ name, arguments: args })) as Result;
  if (result.isError) throw new Error(result.content[0]!.text);
  return result;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

test("the hosts render a structured result they are not told is complete as compact JSON: no indentation, and a quarter or more smaller than indented", async () => {
  const { client, seeded } = await world();
  // format: "full" is not marked complete (packages/server/inbox-mcp-window.test.ts covers the marked results).
  const read = await call(client, "read_thread", { thread_id: seeded.threadId, agent_session: "ses_long", format: "full" });
  const rendered = inboxToolResultText(read).text;
  // The text line, a blank line, then the JSON on one line.
  const json = rendered.slice(rendered.indexOf("\n\n") + 2);
  expect(json).not.toContain("\n");
  expect(JSON.parse(json)).toEqual(read.structuredContent);
  const indented = `${read.content[0]!.text}\n\n${JSON.stringify(read.structuredContent, null, 2)}`;
  expect(bytes(rendered)).toBeLessThan(bytes(indented) * 0.75);
});

test("a thread read is a window (limit sets it); format: \"full\" is the whole thread with every record's fields", async () => {
  const { client, seeded } = await world();
  const windowed = await call(client, "read_thread", { thread_id: seeded.threadId, agent_session: "ses_long" });
  expect((windowed.structuredContent.thread.messages as { id: string }[]).map((m) => m.id).slice(-6)).toEqual(seeded.messageIds.slice(-6));
  const limited = await call(client, "read_thread", { thread_id: seeded.threadId, agent_session: "ses_long", limit: 4 });
  expect((limited.structuredContent.thread.messages as { id: string }[]).map((m) => m.id).slice(-4)).toEqual(seeded.messageIds.slice(-4));
  expect(bytes(inboxToolResultText(limited).text)).toBeLessThan(bytes(inboxToolResultText(windowed).text));
  const whole = await call(client, "read_thread", { thread_id: seeded.threadId, agent_session: "ses_long", format: "full" });
  expect((whole.structuredContent.thread.messages as { id: string }[]).map((m) => m.id)).toEqual(seeded.messageIds);
  // The fields tests and proofs read stay on each message: question key and state, attachments' sent_sha256.
  const first = whole.structuredContent.thread.messages[0] as Record<string, any>;
  expect(first.questions[0]).toMatchObject({ key: expect.any(String), state: "sent" });
  const withFile = (whole.structuredContent.thread.messages as Record<string, any>[]).find((m) => (m.attachments ?? []).length > 0)!;
  expect(withFile.attachments[0].sent_sha256).toEqual(expect.any(String));
});

test("send_message refuses a thread shaped like a message id, and says to use reply_to; nothing is written", async () => {
  const { client, project, server, seeded } = await world(1);
  const cursor = server.store.cursor();
  const result = (await client.callTool({
    name: "send_message",
    arguments: { project_path: project, body: "More on this.", thread: ` ${seeded.threadId} `, agent_session: "ses_long" },
  })) as Result;
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe(
    `validation_error: thread: "${seeded.threadId}" is a message id, and thread takes a name. To write in an existing thread, pass reply_to ${seeded.threadId} instead.`,
  );
  expect(server.store.cursor()).toBe(cursor);
  // Lowercase too; and a name that merely starts with msg_ is still a name.
  const lower = (await client.callTool({ name: "send_message", arguments: { project_path: project, body: "x", thread: seeded.threadId.toLowerCase(), agent_session: "ses_long" } })) as Result;
  expect(lower.isError).toBe(true);
  const named = await call(client, "send_message", { project_path: project, body: "A side note.", thread: "msg_ queue drain", agent_session: "ses_long" });
  expect(named.structuredContent.thread_name).toBe("msg_ queue drain");
  // submit_guide routes through the same check.
  const guide = (await client.callTool({
    name: "submit_guide",
    arguments: { project_path: project, body: "A guide.", thread: seeded.threadId, agent_session: "ses_long", snapshot: "{}" },
  })) as Result;
  expect(guide.isError).toBe(true);
  expect(guide.content[0]!.text).toStartWith(`validation_error: thread: "${seeded.threadId}" is a message id`);
});

test("beside reply_to, an id-shaped thread is refused too, and the refusal says to leave thread out (not to pass reply_to again)", async () => {
  const { client, project, server, seeded } = await world(1);
  const cursor = server.store.cursor();
  const result = (await client.callTool({
    name: "send_message",
    arguments: { project_path: project, body: "More on this.", reply_to: seeded.lastAgentMessageId, thread: seeded.threadId, agent_session: "ses_long" },
  })) as Result;
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe(
    `validation_error: thread: "${seeded.threadId}" is a message id, and thread takes a name. You passed reply_to, which already places this message: leave thread out (or, to name a thread the person started, pass a few words).`,
  );
  expect(server.store.cursor()).toBe(cursor);
  // Without the id-shaped thread the same reply lands in the thread.
  const sent = await call(client, "send_message", { project_path: project, body: "More on this.", reply_to: seeded.lastAgentMessageId, agent_session: "ses_long" });
  expect(sent.structuredContent.thread_id).toBe(seeded.threadId);
});

test("read_thread's list is one short row per thread, with the caller's unread", async () => {
  const { client, project, server, seeded } = await world(2);
  // The person's reply to the second round is unread until an agent reads it.
  await seeded.answerLast();
  await call(client, "send_message", { project_path: project, body: "A side note.", thread: "side", agent_session: "ses_long" });
  const listed = await call(client, "read_thread", { project_path: project, agent_session: "ses_long" });
  const rows = listed.structuredContent.threads as Record<string, any>[];
  expect(rows.map((r) => r.thread_name)).toEqual(["side", null]);
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual([
      "last_at",
      "last_author",
      "last_person_at",
      "last_person_message_id",
      "message_count",
      "questions",
      "section",
      "subject",
      "thread_id",
      "thread_name",
      "unread",
    ]);
  }
  const long = rows.find((r) => r.thread_id === seeded.threadId)!;
  const lastReply = seeded.messageIds.length; // the reply answerLast wrote is the newest message
  expect(long).toMatchObject({ section: "sent", message_count: lastReply + 1, questions: { open: 0, picked: 0, prompt: null }, last_author: "person", unread: true });
  const thread = server.store.thread(seeded.threadId)!.messages;
  expect(long.last_person_message_id).toBe(thread.at(-1)!.id);
  expect(long.last_person_at).toBe(thread.at(-1)!.created_at);
  expect(rows.find((r) => r.thread_name === "side")).toMatchObject({
    last_author: "agent",
    unread: false,
    message_count: 1,
    questions: { open: 0, picked: 0, prompt: null },
    last_person_at: null,
    last_person_message_id: null,
  });

  // Reading the thread reads the reply: no longer unread.
  await call(client, "read_thread", { thread_id: seeded.threadId, agent_session: "ses_long" });
  const after = (await call(client, "read_thread", { project_path: project, agent_session: "ses_long" })).structuredContent.threads as Record<string, any>[];
  expect(after.find((r) => r.thread_id === seeded.threadId)!.unread).toBe(false);

  // A resolved thread, listed with include_resolved, carries resolved_at.
  await call(client, "resolve_message", { message_id: seeded.threadId });
  const all = (await call(client, "read_thread", { project_path: project, agent_session: "ses_long", include_resolved: true })).structuredContent.threads as Record<string, any>[];
  expect(all.find((r) => r.thread_id === seeded.threadId)!.resolved_at).toEqual(expect.any(String));
  expect(server.store.message(seeded.threadId)!.resolved_at).not.toBeNull();
});

test("the Inbox's own notes are not the person's last message and never make a row unread (Mark read through the real route)", async () => {
  const { client, project, server, seeded } = await world(1, { setAsideDelayMs: 50 });
  // Mark read closes the open questions; after the Undo window the agent gets one set-aside note.
  const read = await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${seeded.threadId}/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession }),
  });
  expect(read.status).toBe(200);
  const deadline = Date.now() + 5000;
  const noteOf = () => server.store.thread(seeded.threadId)!.messages.find((m) => m.author.kind === "person" && (m.set_aside?.length ?? 0) > 0);
  while (!noteOf() && Date.now() < deadline) await Bun.sleep(25);
  expect(noteOf()).toBeDefined();
  const row = ((await call(client, "read_thread", { project_path: project, agent_session: "ses_long" })).structuredContent.threads as Record<string, any>[]).find(
    (r) => r.thread_id === seeded.threadId,
  )!;
  expect(row).toMatchObject({ last_person_at: null, last_person_message_id: null, unread: false });

  // A real reply after the note is the person's last message, and unread until read.
  const reply = await fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${seeded.lastAgentMessageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: "after-note", words: "Actually, one more thing." }),
  });
  expect(reply.status).toBe(200);
  const replyId = ((await reply.json()) as { reply: { id: string } }).reply.id;
  const after = ((await call(client, "read_thread", { project_path: project, agent_session: "ses_long" })).structuredContent.threads as Record<string, any>[]).find(
    (r) => r.thread_id === seeded.threadId,
  )!;
  expect(after).toMatchObject({ last_person_message_id: replyId, unread: true });
});

test("read_thread's list stays small: under 400 bytes a thread as the hosts render it", async () => {
  const { client, project } = await world(1);
  for (let i = 0; i < 16; i++) {
    await call(client, "send_message", {
      project_path: project,
      body: `Side thread ${i}.\n\n:::question\nShip side ${i}?\n\nHolds up: release ${i}\n\n- [ ] Yes\n- [ ] No\n:::`,
      thread: `side ${i}`,
      agent_session: "ses_long",
    });
  }
  const listed = await call(client, "read_thread", { project_path: project, agent_session: "ses_long" });
  expect(listed.structuredContent.threads).toHaveLength(17);
  expect(bytes(inboxToolResultText(listed).text)).toBeLessThan(17 * 400);
});

