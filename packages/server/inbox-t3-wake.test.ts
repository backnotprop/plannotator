/**
 * The T3 Code wake (inbox-t3-wake.ts), through the Inbox's real doors: a T3
 * thread's send_message over MCP as the shim sends it, the person's reply
 * route, and a scripted T3 MCP endpoint behind a grant saved the way
 * `plannotator t3 login` saves it. No T3 server is run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { T3Credentials } from "@plannotator/t3-code/auth";
import type { T3Rpc } from "@plannotator/t3-code/t3-client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_REPLY_ARRIVES_TEXT, INBOX_REPLY_READ_LATER_TEXT } from "./inbox-mcp";

const THREAD = "00000000-0000-4000-8000-000000000001";
const ENDPOINT = new URL("http://127.0.0.1:3773/mcp");

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A T3 environment that has `threads`; `fail` makes the next sends throw that text. */
function fakeT3(threads: string[]) {
  const sends: Record<string, unknown>[] = [];
  const attempts: unknown[] = [];
  const state = { fail: null as string | null, down: false };
  const rpc: T3Rpc = {
    async call(name, args) {
      const threadId = args.threadId as string;
      if (state.down) throw new Error("fetch failed");
      if (!threads.includes(threadId)) throw new Error(`T3 ${name}: The thread was not found.`);
      if (name === "t3_thread_read") {
        return {
          thread: { threadId, projectId: "p", status: "idle", activeRunId: null, latestRunId: null, itemCount: 0, worktreePath: null, archived: false, pendingRequestCount: 0 },
          recentRuns: [], items: [], nextPosition: null, hasMore: false,
        };
      }
      attempts.push(args.clientRequestId);
      if (state.fail) throw new Error(`T3 ${name}: ${state.fail}`);
      sends.push(args);
      return { threadId, messageId: `m${sends.length}`, runId: "r", status: "queued", delivery: "queued" };
    },
  };
  return { rpc, sends, attempts, state, threads };
}

async function world(options: { grant?: boolean; threads?: string[]; now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-t3-wake-"));
  roots.push(root);
  const dataDir = join(root, "data");
  if (options.grant !== false) new T3Credentials(dataDir, ENDPOINT).save({ endpoint: ENDPOINT.href, epoch: "e1", tokens: { access_token: "tok", token_type: "Bearer" } });
  const t3 = fakeT3(options.threads ?? [THREAD]);
  const server = await startInboxServer({ dataDir, t3Wake: { connect: async () => t3.rpc, ...(options.now ? { now: options.now } : {}) } });
  servers.push(server);
  const client = new Client({ name: "claude-code", version: "2.1.316" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const send = async (body: string, thread = THREAD) => {
    const result = await client.callTool({ name: "send_message", arguments: { body, project_path: root, agent_session: thread, agent_host: "t3", agent_name: "T3 Code" } });
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
  return { server, client, t3, send, reply, thread };
}

describe("a reply to a T3 Code thread", () => {
  test("goes in once as a queued T3 turn, and is delivered when T3 takes it", async () => {
    const w = await world();
    const sent = await w.send("Ship the worker today?");
    expect(sent.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    expect((await w.thread(sent.thread_id)).messages[0]).toMatchObject({ author: { host: "t3", session: THREAD }, wakes: true });

    const replyId = await w.reply(sent.message_id, "Yes, ship it.");
    await w.server.t3Wake.sweep();
    await w.server.t3Wake.sweep();

    expect(w.t3.sends).toHaveLength(1);
    const call = w.t3.sends[0]!;
    expect(call).toMatchObject({ threadId: THREAD, mode: "queue" });
    expect(call.clientRequestId).toBe(`plannotator-inbox-${replyId}`);
    const message = String(call.message);
    expect(message.split("\n")[0]).toBe(`Plannotator Inbox: a reply (${replyId})`);
    expect(message).toContain("Yes, ship it.");
    // The tools as an MCP client lists them, never the plannotator_inbox tool T3's agent does not have.
    expect(message).not.toContain("plannotator_inbox");
    expect((await w.thread(sent.thread_id)).messages.at(-1)!.delivery).toMatchObject({ host: "t3", session: THREAD });
  });

  test("a failed send is tried again under the same request id; a thread T3 lost is ended until it calls again", async () => {
    const w = await world();
    const sent = await w.send("Which cache?");
    w.t3.state.fail = "connection reset";
    await w.reply(sent.message_id, "The edge one.");
    await w.server.t3Wake.sweep();
    expect(w.t3.sends).toHaveLength(0);
    expect(w.server.t3Wake.status(THREAD)).toBe("alive");

    // T3 lost the thread: ended, and nothing more is tried for it.
    w.t3.state.fail = "The thread was not found.";
    const second = await w.send("Second question?");
    await w.reply(second.message_id, "Second answer.", "k2");
    await w.server.t3Wake.sweep();
    expect(w.server.t3Wake.status(THREAD)).toBe("dead");

    // The thread calls the Inbox again: alive, and both replies go in.
    w.t3.state.fail = null;
    await w.client.callTool({ name: "read_thread", arguments: { agent_session: THREAD, agent_host: "t3", project_path: "/" } });
    await w.server.t3Wake.sweep();
    expect(w.server.t3Wake.status(THREAD)).toBe("alive");
    expect(w.t3.sends.map((call) => String(call.message))).toEqual([expect.stringContaining("The edge one."), expect.stringContaining("Second answer.")]);
    // T3 takes a request id once: the retry of a send that may have landed can never be a second turn.
    expect(w.t3.sends[0]!.clientRequestId).toBe(w.t3.attempts[0]);
  });

  test("a retry that came due stops once the thread is ended: no sweep loop while nothing can be sent", async () => {
    let clock = Date.now();
    const w = await world({ now: () => clock });
    const sent = await w.send("Which cache?");
    w.t3.state.fail = "connection reset";
    await w.reply(sent.message_id, "The edge one.");
    await w.server.t3Wake.sweep();
    clock += 60_000;
    w.t3.state.fail = "The thread was not found.";
    await w.server.t3Wake.sweep();
    expect(w.server.t3Wake.status(THREAD)).toBe("dead");
    // The sweep the store's last line queued runs first: it is work, not a retry.
    await Bun.sleep(0);
    await w.server.t3Wake.sweep();
    let sweeps = 0;
    const pendingFor = w.server.store.pendingRepliesFor.bind(w.server.store);
    w.server.store.pendingRepliesFor = (...args) => (sweeps++, pendingFor(...args));
    await Bun.sleep(100);
    expect(sweeps).toBe(0);
  });

  test("a lookup that could not reach T3 is tried again, never taken for a missing grant", async () => {
    let clock = Date.now();
    const w = await world({ now: () => clock });
    const sent = await w.send("Which cache?");
    w.t3.state.fail = "connection reset";
    await w.reply(sent.message_id, "The edge one.");
    await w.server.t3Wake.sweep();
    // The send failed, and T3 is then down for the lookup too.
    w.t3.state.fail = null;
    w.t3.state.down = true;
    clock += 31_000;
    await w.server.t3Wake.sweep();
    // Back within a minute: the thread is still found, and the reply goes on its next try.
    w.t3.state.down = false;
    expect(await w.server.t3Wake.wakes("t3", THREAD)).toBe(true);
    clock += 61_000;
    await w.server.t3Wake.sweep();
    expect(w.t3.sends.map((call) => String(call.message))).toEqual([expect.stringContaining("The edge one.")]);
  });

  test("a thread no saved grant reaches any more is not offered as one the Inbox wakes", async () => {
    let clock = Date.now();
    const w = await world({ now: () => clock });
    const sent = await w.send("Which cache?");
    expect(w.server.t3Wake.status(THREAD)).toBe("alive");
    w.t3.state.fail = "connection reset";
    await w.reply(sent.message_id, "The edge one.");
    await w.server.t3Wake.sweep();
    // The grant's environment no longer has the thread: T3 answers the next lookup with "not found".
    w.t3.threads.length = 0;
    clock += 31_000;
    await w.server.t3Wake.sweep();
    expect(w.server.t3Wake.status(THREAD)).toBeNull();
  });

  test("without a grant that reaches the thread, the agent is told to read it later and nothing is sent", async () => {
    for (const options of [{ grant: false }, { threads: [] }]) {
      const w = await world(options);
      const sent = await w.send("Anyone there?");
      expect(sent.text).toContain(INBOX_REPLY_READ_LATER_TEXT);
      await w.reply(sent.message_id, "Here.");
      await w.server.t3Wake.sweep();
      expect(w.t3.sends).toHaveLength(0);
    }
  });
});
