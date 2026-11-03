/**
 * Emoji reactions on a real Inbox (approval "inbox-emoji-reactions"): the
 * setting (config.json `inboxReactions`, Settings → Capabilities' last card)
 * saved through one request reads the same from every other one and after a
 * restart; Off means no reaction at all; with reactions on, the reaction is
 * decided as the agent receives the reply, stored with the delivery, the same
 * after the Inbox restarts, and never shown to the agent.
 *
 * What regresses: a setting one device changes that another never sees, an
 * Off that still reacts, a reaction lost on reload (or drawn differently per
 * device), a reaction leaking into the agent's own thread.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reactions-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const project = join(root, "app");
  mkdirSync(project, { recursive: true });
  // config.json is read through the env: this test's own.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  return { dataDir, project };
}

async function open(dataDir: string) {
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-reactions-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const settings = async () => (await (await fetch(`${base}/api/inbox/settings`)).json()) as { reactions: { level: string; sound: boolean } };
  const save = (reactions: unknown) =>
    fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reactions }) });
  const thread = async (id: string) => ((await (await fetch(`${base}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
  /** An agent asks in its own thread, the person answers, the agent's session receives the reply. */
  const exchange = async (project: string, session: string, question: string, answer: string) => {
    const asked = (
      await client.callTool({
        name: "send_message",
        arguments: { body: question, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code" },
      })
    ).structuredContent as { message_id: string; thread_id: string };
    const replied = await fetch(`${base}/api/inbox/messages/${asked.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `send-${asked.message_id}`, words: answer }),
    });
    expect(replied.status).toBe(200);
    const replyId = ((await replied.json()) as { reply: { id: string } }).reply.id;
    const delivered = await fetch(`${base}${INBOX_BRIDGE_EVENT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session, host: "claude-code", type: "delivered", id: replyId }),
    });
    expect(delivered.status).toBe(200);
    return { threadId: asked.thread_id, replyId };
  };
  /** read_thread as the agent calls it: what it gets back, whole (its text and its structured content). */
  const agentRead = async (threadId: string) => {
    const result = (await client.callTool({ name: "read_thread", arguments: { thread_id: threadId } })) as { isError?: boolean };
    expect(result.isError ?? false).toBe(false);
    return JSON.stringify(result);
  };
  return { server, settings, save, thread, exchange, agentRead };
}

const THANKS = ["Perfect, that's exactly what I wanted.", "thanks, appreciate it", "It works now! Finally.", "Beautiful.", "Great work, thank you!", "YES IT WORKS", "Love it, thanks!", "Amazing, nice work."];

test("the setting: Now and then with sound by default; a change reads the same from any request and after a restart", async () => {
  const { dataDir } = await world();
  const first = await open(dataDir);
  expect((await first.settings()).reactions).toEqual({ level: "sometimes", sound: true });

  const saved = await first.save({ level: "often", sound: false });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { reactions: unknown }).reactions).toEqual({ level: "often", sound: false });
  // Another device's request, then config.json itself, then a restarted Inbox.
  expect((await first.settings()).reactions).toEqual({ level: "often", sound: false });
  expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxReactions).toEqual({ level: "often", sound: false });
  first.server.stop();
  const second = await open(dataDir);
  expect((await second.settings()).reactions).toEqual({ level: "often", sound: false });

  // Only one part changes; a bad value changes nothing.
  expect((await second.save({ level: "off" })).status).toBe(200);
  expect((await second.settings()).reactions).toEqual({ level: "off", sound: false });
  expect((await second.save({ level: "always" })).status).toBe(422);
  expect((await second.save({ sound: "yes" })).status).toBe(422);
  expect((await second.settings()).reactions).toEqual({ level: "off", sound: false });
});

test("Off: no reply gets a reaction", async () => {
  const { dataDir, project } = await world();
  const inbox = await open(dataDir);
  expect((await inbox.save({ level: "off" })).status).toBe(200);
  for (const [i, words] of THANKS.entries()) {
    const { threadId } = await inbox.exchange(project, `ses_${i}`, `Question ${i}?`, words);
    for (const message of (await inbox.thread(threadId)).messages) expect(message.reaction ?? null).toBeNull();
  }
});

test("on: the reaction is stored with the delivery, the same after a restart, and never in the agent's view", async () => {
  const { dataDir, project } = await world();
  const inbox = await open(dataDir);
  expect((await inbox.save({ level: "often" })).status).toBe(200);
  // Thanks that keeps getting nothing is owed: within a few replies one gets a reaction.
  let reacted: { threadId: string; replyId: string } | null = null;
  for (const [i, words] of THANKS.entries()) {
    const session = `ses_${i}`;
    const sent = await inbox.exchange(project, session, `Question ${i}?`, words);
    const reply = (await inbox.thread(sent.threadId)).messages.find((m) => m.id === sent.replyId)!;
    expect(reply.delivery?.state).toBe("delivered");
    if (reply.reaction) {
      reacted = sent;
      // Lands 0.8 to 2.5 s after the agent received it.
      const after = Date.parse(reply.reaction.at) - Date.parse(reply.delivery!.at);
      expect(after).toBeGreaterThanOrEqual(800);
      expect(after).toBeLessThanOrEqual(2500);
      break;
    }
  }
  expect(reacted).not.toBeNull();
  const { threadId, replyId } = reacted!;
  const before = (await inbox.thread(threadId)).messages.find((m) => m.id === replyId)!.reaction;
  // Nothing else in the thread has one: only the person's reply.
  for (const message of (await inbox.thread(threadId)).messages) if (message.id !== replyId) expect(message.reaction ?? null).toBeNull();
  // The agent's own view of the thread never carries it.
  const agentView = await inbox.agentRead(threadId);
  expect(agentView).toContain(replyId);
  expect(agentView).not.toContain('"reaction"');
  expect(agentView).not.toContain(before!.emoji);

  inbox.server.stop();
  const again = await open(dataDir);
  expect((await again.thread(threadId)).messages.find((m) => m.id === replyId)!.reaction).toEqual(before);
});
