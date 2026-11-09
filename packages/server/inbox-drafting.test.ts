/**
 * A message being written reaches the windows (prototype: live drawings):
 * the bridge's `drafting` event, through a running server on loopback, to a
 * window's event stream. Every test uses its own temp data dir.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_BRIDGE_EVENT_PATH } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const aborts: AbortController[] = [];

afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-drafting-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-drafting-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const sent = await client.callTool({
    name: "send_message",
    arguments: { body: "First.", project_path: project, agent_session: "s1", agent_host: "claude-code", agent_name: "Claude Code" },
  });
  return { server, first: sent.structuredContent as { message_id: string; thread_id: string } };
}

/** A window's event stream: answers the `drafting` frames heard so far. */
async function windowStream(server: InboxServer): Promise<{ frames: unknown[]; heard: (count: number) => Promise<void> }> {
  const abort = new AbortController();
  aborts.push(abort);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/events?window=window-0001&permission=default&origin=http%3A%2F%2Flocalhost`, { signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: unknown[] = [];
  let text = "";
  let hello = false;
  const read = async () => {
    const { value, done } = await reader.read();
    if (done) throw new Error("the stream ended");
    text += decoder.decode(value, { stream: true });
    for (let at = text.indexOf("\n\n"); at >= 0; at = text.indexOf("\n\n")) {
      const frame = text.slice(0, at);
      text = text.slice(at + 2);
      if (frame.includes("event: hello")) hello = true;
      if (frame.includes("event: drafting")) frames.push(JSON.parse(frame.slice(frame.indexOf("data: ") + 6)));
    }
  };
  while (!hello) await read();
  return {
    frames,
    heard: async (count) => {
      while (frames.length < count) await read();
    },
  };
}

function drafting(server: InboxServer, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_EVENT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session: "s1", host: "claude-code", type: "drafting", ...body }),
  });
}

test("a reply being written reaches the window with its thread and its body so far, and nothing is stored", async () => {
  const { server, first } = await setup();
  const stream = await windowStream(server);
  const whole = JSON.stringify({ action: "send_message", reply_to: first.message_id, body: "Look:\n```svg\n<svg><rect/></svg>\n```" });
  const cut = whole.indexOf("<rect") + 3;
  expect((await drafting(server, { call: "call-1", json: whole.slice(0, cut) })).status).toBe(200);
  expect((await drafting(server, { call: "call-1", json: whole, done: true })).status).toBe(200);
  await stream.heard(2);
  expect(stream.frames).toEqual([
    { call: "call-1", session: "s1", thread_id: first.thread_id, body: "Look:\n```svg\n<svg><re", done: false },
    { call: "call-1", session: "s1", thread_id: first.thread_id, body: "Look:\n```svg\n<svg><rect/></svg>\n```", done: true },
  ]);
  const thread = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${first.thread_id}`)).json()) as { thread: { messages: unknown[] } };
  expect(thread.thread.messages).toHaveLength(1);
});

test("a draft whose thread is not known yet is accepted and tells no window", async () => {
  const { server, first } = await setup();
  const stream = await windowStream(server);
  // The body before `reply_to`, then a new thread's message: neither has a thread to draw in.
  expect((await drafting(server, { call: "call-2", json: '{"action":"send_message","body":"```svg\\n<svg>' })).status).toBe(200);
  expect((await drafting(server, { call: "call-3", json: '{"action":"read_thread","reply_to":"' + first.message_id + '","body":"x"}' })).status).toBe(200);
  // A known one after them is the first the window hears.
  await drafting(server, { call: "call-4", json: JSON.stringify({ action: "send_message", reply_to: first.message_id, body: "b" }) });
  await stream.heard(1);
  expect(stream.frames).toHaveLength(1);
  expect((stream.frames[0] as { call: string }).call).toBe("call-4");
});
