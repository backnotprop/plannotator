/**
 * An Orca chat's wake (`pollingWakeHost` in inbox.ts): Orca's plugin polls the bridge as host `orca` and the chat's
 * session, and puts the person's reply in as the chat's next message. send_message over MCP as the chat sends it (no
 * `_meta` of its own), the person's reply route and the bridge poll, through the Inbox's real doors.
 *
 * What this catches: an Orca chat no connection polls for told its reply arrives by itself (it never would); one
 * whose plugin polls told to read it later; the reply not handed to that poll, or handed again once delivered; the
 * promise kept after the plugin stopped polling.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_REPLY_ARRIVES_TEXT, INBOX_REPLY_READ_LATER_TEXT } from "./inbox-mcp";

const CHAT = "orca-chat-1";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-orca-wake-"));
  roots.push(root);
  const clock = { now: Date.now() };
  const server = await startInboxServer({ dataDir: join(root, "data"), sessionsNow: () => clock.now });
  servers.push(server);
  const client = new Client({ name: "orca", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const bridge = (path: string, body: Record<string, unknown>) =>
    fetch(`${base}/api/inbox/bridge/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: CHAT, host: "orca", ...body }),
    });
  const poll = async () => ((await (await bridge("poll", { waitMs: 0 })).json()) as { commands: { id: string }[] }).commands.map((command) => command.id);
  const send = async (body: string) => {
    const result = await client.callTool({ name: "send_message", arguments: { body, project_path: root, agent_session: CHAT, agent_host: "orca", agent_name: "Orca" } });
    return { ...(result.structuredContent as { message_id: string; thread_id: string }), text: (result.content as { text: string }[])[0]!.text };
  };
  const reply = async (messageId: string, words: string, key = "k1") => {
    const response = await fetch(`${base}/api/inbox/messages/${messageId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: key, words }),
    });
    return ((await response.json()) as { reply: { id: string } }).reply.id;
  };
  const thread = async (id: string) => ((await (await fetch(`${base}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
  return { clock, poll, delivered: (id: string) => bridge("event", { type: "delivered", id }), send, reply, thread };
}

test("an Orca chat no connection polls for is told to read its reply later", async () => {
  const w = await world();
  const sent = await w.send("Which region?");
  expect(sent.text).toContain(INBOX_REPLY_READ_LATER_TEXT);
  expect(sent.text).not.toContain(INBOX_REPLY_ARRIVES_TEXT);
});

test("while its plugin polls, an Orca chat's reply arrives by itself: handed to the poll once, and delivered", async () => {
  const w = await world();
  expect(await w.poll()).toEqual([]);
  const sent = await w.send("Ship the worker today?");
  expect(sent.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
  const replyId = await w.reply(sent.message_id, "Yes, ship it.");
  expect(await w.poll()).toEqual([replyId]);
  await w.delivered(replyId);
  expect(await w.poll()).toEqual([]);
  expect((await w.thread(sent.thread_id)).messages.at(-1)!.delivery).toMatchObject({ host: "orca", session: CHAT });
  // Once the plugin stopped polling, the next message promises nothing.
  w.clock.now += 31_000;
  expect((await w.send("And the region?")).text).toContain(INBOX_REPLY_READ_LATER_TEXT);
});
