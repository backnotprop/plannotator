/**
 * Decision data's Ask (approval decision-data), through the server's real doors: a Send with `decision_ask` keeps the
 * person's words as typed, and only what the agent receives for that message carries the instructions, once. The
 * connections are plain HTTP calls with the registry's token and a real MCP client, never a real agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_DECISION_ASK_BLOCK, INBOX_DECISION_ASK_OPEN, type InboxMessage, type InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, inboxWakeText, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { INBOX_CODEX_MESSAGE_MAX_BYTES, codexQueueMessage } from "./inbox-codex-wake";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-decision-ask-")));
  roots.push(root);
  const project = join(root, "harbor");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-decision-ask-test", version: "1.0.0" });
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

function post(server: InboxServer, path: string, body: Record<string, unknown>) {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
}

async function send(server: InboxServer, body: Record<string, unknown>): Promise<{ thread_id: string; message: InboxMessage; replayed: boolean }> {
  const response = await post(server, "/api/inbox/messages", { to: { session: "ses-a" }, ...body });
  expect(response.status).toBe(200);
  return (await response.json()) as never;
}

async function readThreadText(client: Client, threadId: string): Promise<string> {
  const result = (await client.callTool({ name: "read_thread", arguments: { thread_id: threadId, agent_session: "ses-a" } })) as { content: { text: string }[] };
  return result.content.map((part) => part.text).join("\n");
}

const count = (text: string, part: string) => text.split(part).length - 1;
const QUESTION = "Why did we drop the old job queue?";

describe("Decision data's Ask", () => {
  test("the stored words stay as typed; the delivered turn, Codex's queue and read_thread carry the instructions once, after the words", async () => {
    const { server, client, project } = await setup();
    await poll(server, "ses-a", project);
    const sent = await send(server, { body: QUESTION, idempotency_key: "k1", decision_ask: true });
    expect(sent.message.body).toBe(QUESTION);

    // What the window reads never holds the instructions.
    const stored = (await (await fetch(`${base(server)}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: InboxThread };
    expect(stored.thread.messages[0]!.body).toBe(QUESTION);
    expect(JSON.stringify(stored)).not.toContain(INBOX_DECISION_ASK_OPEN);

    // A connection that polls again before it reports the delivery is handed the same turn: once each time.
    for (let round = 0; round < 2; round++) {
      const [command] = await poll(server, "ses-a", project);
      expect(command!.body).toBe(`${QUESTION}\n\n${INBOX_DECISION_ASK_BLOCK}`);
      const wake = inboxWakeText(command!);
      expect(count(wake, INBOX_DECISION_ASK_OPEN)).toBe(1);
      expect(wake.split("\n")).toContain(INBOX_DECISION_ASK_OPEN);
      expect(count(codexQueueMessage(command!), INBOX_DECISION_ASK_OPEN)).toBe(1);
    }

    const text = await readThreadText(client, sent.thread_id);
    expect(count(text, INBOX_DECISION_ASK_BLOCK)).toBe(1);

    // A retried Send answers the same thread.
    const replay = await send(server, { body: QUESTION, idempotency_key: "k1", decision_ask: true });
    expect(replay).toMatchObject({ replayed: true, thread_id: sent.thread_id });
    expect(count(await readThreadText(client, sent.thread_id), INBOX_DECISION_ASK_OPEN)).toBe(1);
  });

  test("the answer is an ordinary thread: an agent's reply lands in it and shows in the list like any other", async () => {
    const { server, client, project } = await setup();
    await poll(server, "ses-a", project);
    const sent = await send(server, { body: QUESTION, idempotency_key: "k1", decision_ask: true });
    const answered = (await client.callTool({
      name: "send_message",
      arguments: { project_path: project, reply_to: sent.message.id, body: "I can't tell from what's stored.", agent_session: "ses-a" },
    })) as { isError?: boolean };
    expect(answered.isError).toBeFalsy();
    const list = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: { thread_id: string }[] }[] };
    expect(list.sections.flatMap((s) => s.threads).map((t) => t.thread_id)).toEqual([sent.thread_id]);
    const thread = (await (await fetch(`${base(server)}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: InboxThread };
    expect(thread.thread.messages.map((m) => m.author.kind)).toEqual(["person", "agent"]);
  });

  test("a long question's words are what Codex's queue cuts: the instructions stay whole", async () => {
    const { server, project } = await setup();
    await poll(server, "ses-a", project);
    await send(server, { body: "why ".repeat(INBOX_CODEX_MESSAGE_MAX_BYTES / 2), idempotency_key: "long", decision_ask: true });
    const [command] = await poll(server, "ses-a", project);
    const queued = codexQueueMessage(command!);
    expect(Buffer.byteLength(queued)).toBeLessThanOrEqual(INBOX_CODEX_MESSAGE_MAX_BYTES);
    expect(queued).toContain(INBOX_DECISION_ASK_BLOCK);
  });

  test("nothing else carries the instructions: a plain New message, a truthy non-true flag, a later reply in the thread, or the tool list", async () => {
    const { server, client, project } = await setup();
    await poll(server, "ses-a", project);
    const plain = await send(server, { body: "Retry the webhook.", idempotency_key: "plain" });
    const stringy = await send(server, { body: "Retry the webhook twice.", idempotency_key: "stringy", decision_ask: "true" });
    for (const sent of [plain, stringy]) {
      expect(sent.message.decision_ask).toBeUndefined();
      expect(await readThreadText(client, sent.thread_id)).not.toContain(INBOX_DECISION_ASK_OPEN);
    }
    const asked = await send(server, { body: QUESTION, idempotency_key: "asked", decision_ask: true });
    expect((await post(server, `/api/inbox/messages/${asked.message.id}/reply`, { words: "And when?", idempotency_key: "r1" })).status).toBe(200);
    const commands = await poll(server, "ses-a", project);
    const byWords = (words: string) => commands.find((c) => c.body.startsWith(words))!;
    expect(count(byWords(QUESTION).body, INBOX_DECISION_ASK_OPEN)).toBe(1);
    expect(count(byWords("And when?").body, INBOX_DECISION_ASK_OPEN)).toBe(0);
    expect(count(byWords("Retry the webhook.").body, INBOX_DECISION_ASK_OPEN)).toBe(0);
    const tools = await client.listTools();
    expect(JSON.stringify(tools)).not.toContain(INBOX_DECISION_ASK_OPEN);
  });
});
