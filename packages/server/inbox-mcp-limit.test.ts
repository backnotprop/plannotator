/**
 * read_thread with `limit` set (approval "inbox-wake-context"): a small read on
 * purpose. The newest messages up to the limit in full, 12 KB at most, and one
 * line for every other message. The failures this guards: `limit: 1` answering
 * dozens of messages in full, a message over the cap cut with no way back to it,
 * a question or action item lost from the listing, and a read that shows a
 * queued reply only as a line swallowing its wake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { seedLongThread } from "../../tests/helpers/inbox-long-thread";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_LIMIT_READ_BYTES, INBOX_THREAD_WINDOW } from "./inbox-mcp-read";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

const SESSION = "ses_limit";
const QUESTION = [":::question", "Route through the second region?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
const ACTION = [":::action", "Approve the deploy on Vercel", ":::"].join("\n");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-mcp-limit-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-mcp-limit-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const result = (await client.callTool({ name, arguments: args })) as Result;
    if (result.isError) throw new Error(result.content[0]!.text);
    return result;
  };
  const send = async (body: string, extra: Record<string, unknown> = {}) =>
    (await call("send_message", { body, project_path: project, agent_session: SESSION, agent_host: "claude-code", agent_name: "Claude Code", ...extra })).structuredContent as { message_id: string; thread_id: string };
  let keys = 0;
  const reply = async (messageId: string, words: string) => {
    const response = await fetch(`${base}/api/inbox/messages/${messageId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k-${++keys}`, words }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { reply: { id: string } }).reply.id;
  };
  const poll = async () => {
    const response = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: SESSION, host: "claude-code", project_path: project, waitMs: 0, tags: true }),
    });
    expect(response.status).toBe(200);
    return parseInboxBridgeCommands(await response.text());
  };
  return { root, project, server, client, call, send, reply, poll };
}

describe("read_thread with limit", () => {
  test("limit: 1 on a long thread with many replies: one message in full, one line for each of the others", async () => {
    const w = await world();
    const seeded = await seedLongThread({ client: w.client, port: w.server.port, project: w.project, rounds: 30, session: SESSION });
    const { thread, window } = (await w.call("read_thread", { thread_id: seeded.threadId, limit: 1, agent_session: SESSION })).structuredContent;
    const all = seeded.messageIds;
    expect(thread.messages.map((m: any) => m.id)).toEqual(all.slice(-1));
    expect(thread.earlier.map((l: any) => l.id)).toEqual(all.slice(0, -1));
    expect(window).toMatchObject({ limit: 1, full: 1, newest: 1, person_earlier: 0, expanded: 0, lines: all.length - 1 });
  });

  test("with no limit, the default read is what it was: the newest six, and the person's earlier messages", async () => {
    const w = await world();
    const seeded = await seedLongThread({ client: w.client, port: w.server.port, project: w.project, rounds: 20, session: SESSION });
    const { window } = (await w.call("read_thread", { thread_id: seeded.threadId, agent_session: SESSION })).structuredContent;
    expect(window.limit).toBe(INBOX_THREAD_WINDOW);
    expect(window.newest).toBe(INBOX_THREAD_WINDOW);
    expect(window.person_earlier).toBeGreaterThan(0);
    expect(window.capped).toBeUndefined();
  });

  test("the cap holds across messages: the newest first, the one that does not fit cut to what is left, older ones as lines", async () => {
    const w = await world();
    const first = await w.send("old message");
    const big = await w.send("b".repeat(5 * 1024), { reply_to: first.message_id });
    const middle = await w.send("m".repeat(10 * 1024), { reply_to: big.message_id });
    const newest = await w.send("n".repeat(8 * 1024), { reply_to: middle.message_id });
    const { thread } = (await w.call("read_thread", { thread_id: first.thread_id, limit: 4, agent_session: SESSION })).structuredContent;
    expect(thread.messages.map((m: any) => m.id)).toEqual([middle.message_id, newest.message_id]);
    expect(thread.messages[1].body).toBe("n".repeat(8 * 1024));
    const cut = thread.messages[0];
    expect(cut.body).toStartWith("m".repeat(4 * 1024));
    expect(cut.body).toContain(`read_thread expand: ["${middle.message_id}"]`);
    expect(cut.body_bytes).toBe(10 * 1024);
    expect(thread.earlier.map((l: any) => l.id)).toEqual([first.message_id, big.message_id]);
    const shownInFull = thread.messages.reduce((sum: number, m: any) => sum + bytes(m.body.split("\n\n[… cut")[0]), 0);
    expect(shownInFull).toBeLessThanOrEqual(INBOX_LIMIT_READ_BYTES);
  });

  test("one message over the cap is cut with a plain way back; expand and message_id then show it whole", async () => {
    const w = await world();
    const words = "word ".repeat(8000);
    const first = await w.send("Before.");
    const huge = await w.send(words, { reply_to: first.message_id });
    const read = await w.call("read_thread", { thread_id: first.thread_id, limit: 1, agent_session: SESSION });
    const shown = read.structuredContent.thread.messages[0];
    expect(shown.id).toBe(huge.message_id);
    expect(bytes(shown.body.split("\n\n[… cut")[0])).toBeLessThanOrEqual(INBOX_LIMIT_READ_BYTES);
    expect(shown.body.endsWith(`read_thread expand: ["${huge.message_id}"] shows the rest]`)).toBe(true);
    expect(read.content[0]!.text).toContain("up to 12.0 KB");

    for (const args of [{ thread_id: first.thread_id, expand: [huge.message_id], limit: 1 }, { message_id: huge.message_id, limit: 1 }]) {
      const whole = (await w.call("read_thread", { ...args, agent_session: SESSION })).structuredContent.thread.messages.find((m: any) => m.id === huge.message_id);
      expect(whole.body).toBe(words);
      expect(whole.body_bytes).toBeUndefined();
    }
  });

  test("expand is on top of the cap: it never pushes the newest messages out", async () => {
    const w = await world();
    const first = await w.send("o".repeat(11 * 1024));
    const newest = await w.send("n".repeat(11 * 1024), { reply_to: first.message_id });
    const { thread } = (await w.call("read_thread", { thread_id: first.thread_id, limit: 1, expand: [first.message_id], agent_session: SESSION })).structuredContent;
    expect(thread.messages.map((m: any) => m.id)).toEqual([first.message_id, newest.message_id]);
    expect(thread.messages.map((m: any) => m.body_bytes)).toEqual([undefined, undefined]);
  });

  test("no listing is lost: open questions and action items in the header, an old one's state on its line, however small the read", async () => {
    const w = await world();
    const asked = await w.send(QUESTION);
    const acting = await w.send(ACTION, { reply_to: asked.message_id });
    let last = acting.message_id;
    for (let i = 0; i < 8; i++) last = (await w.send(`Update ${i}.`, { reply_to: last })).message_id;
    const read = await w.call("read_thread", { thread_id: asked.thread_id, limit: 1, agent_session: SESSION });
    const { thread } = read.structuredContent;
    expect(thread.open_questions.map((q: any) => q.message_id)).toEqual([asked.message_id, acting.message_id]);
    const text = read.content[0]!.text;
    expect(text).toContain("Waiting on the person (2):");
    expect(text).toContain("Route through the second region?");
    expect(text).toContain("Approve the deploy on Vercel");
    const lines = new Map(thread.earlier.map((l: any) => [l.id, l]));
    expect((lines.get(asked.message_id) as any).questions).toHaveLength(1);
    expect((lines.get(acting.message_id) as any).questions).toHaveLength(1);
    // A question on a cut message keeps its listing too.
    const cut = await w.send(`${"x".repeat(13 * 1024)}\n\n${QUESTION}`, { reply_to: last });
    const small = (await w.call("read_thread", { thread_id: asked.thread_id, limit: 1, agent_session: SESSION })).structuredContent.thread.messages[0];
    expect(small.id).toBe(cut.message_id);
    expect(small.questions).toHaveLength(1);
  });

  test("a queued reply the read shows only as a line stays queued: its wake still comes, in full", async () => {
    const w = await world();
    const asked = await w.send("Asking.");
    const replyId = await w.reply(asked.message_id, "A long answer the agent has not had yet.");
    // The agent writes on before its connection takes the reply.
    await w.send("Meanwhile, another update.", { reply_to: asked.message_id });
    const { thread } = (await w.call("read_thread", { thread_id: asked.thread_id, limit: 1, agent_session: SESSION })).structuredContent;
    expect(thread.earlier.map((l: any) => l.id)).toContain(replyId);
    expect((await w.poll()).map((c) => c.id)).toEqual([replyId]);
  });

  test("a queued reply the read shows in full is settled, as any read settles it", async () => {
    const w = await world();
    const asked = await w.send("Asking.");
    const replyId = await w.reply(asked.message_id, "An answer.");
    const { thread } = (await w.call("read_thread", { thread_id: asked.thread_id, limit: 1, agent_session: SESSION })).structuredContent;
    expect(thread.messages.map((m: any) => m.id)).toEqual([replyId]);
    expect(await w.poll()).toEqual([]);
  });
});
