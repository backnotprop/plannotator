/**
 * A Send that asks for the thread with its answer (`with_thread`, the window's last reply of a Send) gets exactly what
 * a read of the thread would answer right after it, so the window draws the sent reply with no read after it
 * (slow-link fixes, 2026-11-10). Without the flag the answer is unchanged. A running server on loopback, real
 * `fetch`, an agent over MCP, a temp data dir per test.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Json = Record<string, any>;
const ASK = [":::question", "Which layout?", "", "- [ ] Cards", "- [ ] A dense table", ":::"].join("\n");

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reply-thread-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project);
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null });
  servers.push(server);
  const client = new Client({ name: "inbox-reply-thread-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const result = (await client.callTool({ name: "send_message", arguments: { project_path: project, body: ASK } })) as { isError?: boolean; content: { text: string }[]; structuredContent: Json };
  if (result.isError) throw new Error(result.content[0]!.text);
  const origin = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: Json) =>
    fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, serverSession: server.serverSession }) });
  return { origin, sent: result.structuredContent, post };
}

test("with_thread: the answer carries the thread as its read answers now, the sent reply in it", async () => {
  const { origin, sent, post } = await setup();
  const answer = (await (await post(`/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "send-1", words: "Cards it is.", with_thread: true })).json()) as Json;
  expect(answer.reply.body).toContain("Cards it is.");
  const read = (await (await fetch(`${origin}/api/inbox/threads/${sent.thread_id}`)).json()) as Json;
  // The same thread, the sent reply last, in the shape a read draws (its seq and sent comments included).
  expect(answer.thread_read.thread).toEqual(read.thread);
  expect(answer.thread_read.row).toEqual(read.row);
  expect(answer.thread_read.thread.messages.at(-1)).toMatchObject({ id: answer.reply.id, sent_annotations: 0 });
  expect(typeof answer.thread_read.thread.messages.at(-1).seq).toBe("number");
});

test("without with_thread the answer is as before: no thread in it", async () => {
  const { sent, post } = await setup();
  const answer = (await (await post(`/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "send-1", words: "Cards." })).json()) as Json;
  expect(answer.reply.body).toContain("Cards.");
  expect(answer.thread_read).toBeUndefined();
});
