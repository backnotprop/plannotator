import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { T3Credentials } from "@plannotator/t3-code/auth";
import type { T3Rpc } from "@plannotator/t3-code/t3-client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_ASKER_RESTART_GRACE_MS } from "./inbox-sessions";
import { INBOX_REPLY_ARRIVES_TEXT, INBOX_REPLY_READ_LATER_TEXT } from "./inbox-mcp";
import { t3CeilingOfScope, t3GrantModeOf } from "./inbox-t3-wake";
import { type FakeT3, startFakeT3, type T3Access, type T3RuntimeMode, t3ScopeOf } from "../../tests/helpers/fake-t3";

const THREAD = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const ENDPOINT = new URL("http://127.0.0.1:3773/mcp");

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

async function world(options: { grant?: boolean; threads?: string[]; now?: () => number; sessionsNow?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-t3-wake-"));
  roots.push(root);
  const dataDir = join(root, "data");
  if (options.grant !== false) new T3Credentials(dataDir, ENDPOINT).save({ endpoint: ENDPOINT.href, epoch: "e1", tokens: { access_token: "tok", token_type: "Bearer" } });
  const t3 = fakeT3(options.threads ?? [THREAD]);
  const server = await startInboxServer({ dataDir, t3Wake: { connect: async () => t3.rpc, ...(options.now ? { now: options.now } : {}) }, ...(options.sessionsNow ? { sessionsNow: options.sessionsNow, setAsideDelayMs: 50 } : {}) });
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

    w.t3.state.fail = "The thread was not found.";
    const second = await w.send("Second question?");
    await w.reply(second.message_id, "Second answer.", "k2");
    await w.server.t3Wake.sweep();
    expect(w.server.t3Wake.status(THREAD)).toBe("dead");

    w.t3.state.fail = null;
    await w.client.callTool({ name: "read_thread", arguments: { agent_session: THREAD, agent_host: "t3", project_path: "/" } });
    await w.server.t3Wake.sweep();
    expect(w.server.t3Wake.status(THREAD)).toBe("alive");
    expect(w.t3.sends.map((call) => String(call.message))).toEqual([expect.stringContaining("The edge one."), expect.stringContaining("Second answer.")]);
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
    w.t3.state.fail = null;
    w.t3.state.down = true;
    clock += 31_000;
    await w.server.t3Wake.sweep();
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

describe("a reply to a T3 Code thread, over T3's MCP on loopback", () => {
  const fakes: FakeT3[] = [];
  afterEach(() => {
    for (const fake of fakes.splice(0)) fake.stop();
  });

  async function loopback(options: { token?: string; now?: () => number; access?: T3Access; scoped?: boolean; modes?: Record<string, T3RuntimeMode>; lookupTimeoutMs?: number } = {}) {
    const t3 = startFakeT3({ threads: [THREAD, OTHER], ...(options.access ? { access: options.access } : {}), ...(options.modes ? { modes: options.modes } : {}) });
    fakes.push(t3);
    const root = mkdtempSync(join(tmpdir(), "plannotator-t3-loopback-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const grant = new T3Credentials(dataDir, t3.endpoint);
    const login = (epoch: string, token = options.token ?? t3.state.token) =>
      grant.save({ endpoint: t3.endpoint.href, epoch, tokens: { access_token: token, token_type: "Bearer", ...(options.scoped ? { scope: t3ScopeOf(t3.state.access) } : {}) } });
    login("e1");
    const logs: string[] = [];
    const server = await startInboxServer({
      dataDir,
      t3Wake: { log: (line) => logs.push(line), ...(options.now ? { now: options.now } : {}), ...(options.lookupTimeoutMs ? { lookupTimeoutMs: options.lookupTimeoutMs } : {}) },
    });
    servers.push(server);
    const client = new Client({ name: "claude-code", version: "2.1.317" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    clients.push(client);
    const base = `http://127.0.0.1:${server.port}`;
    const send = async (body: string, thread = THREAD) => {
      const result = await client.callTool({ name: "send_message", arguments: { body, project_path: root, agent_session: thread, agent_host: "t3", agent_name: "T3 Code" } });
      return { ...(result.structuredContent as { message_id: string; thread_id: string }), text: (result.content as { text: string }[])[0]!.text };
    };
    const reply = async (messageId: string, words: string, key: string) => {
      const response = await fetch(`${base}/api/inbox/messages/${messageId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: key, words }),
      });
      return ((await response.json()) as { reply: { id: string } }).reply.id;
    };
    const thread = async (id: string) => ((await (await fetch(`${base}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
    return { t3, server, send, reply, thread, logs, login, logout: () => grant.forget() };
  }

  test("goes in once under the item's request id, and is delivered when T3 takes it", async () => {
    const w = await loopback();
    const sent = await w.send("Ship the worker today?");
    expect(sent.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    const replyId = await w.reply(sent.message_id, "Yes, ship it.", "k1");
    await w.server.t3Wake.sweep();
    await w.server.t3Wake.sweep();
    expect(w.t3.turns).toEqual([{ threadId: THREAD, message: expect.stringContaining("Yes, ship it."), clientRequestId: `plannotator-inbox-${replyId}`, mode: "queue" }]);
    expect((await w.thread(sent.thread_id)).messages.at(-1)!.delivery).toMatchObject({ host: "t3", session: THREAD });
  });

  test("a send T3 denies for the grant's mode is refused, never retried, and the log names the grant's mode", async () => {
    let clock = Date.now();
    const w = await loopback({ now: () => clock });
    const sent = await w.send("Which cache?");
    w.t3.state.deny = { code: "runtime_mode_escalation_denied", message: "Child runtime mode full-access is broader than parent mode auto." };
    const replyId = await w.reply(sent.message_id, "The edge one.", "k1");
    await w.server.t3Wake.sweep();
    expect(w.t3.sendCalls).toBe(1);
    expect(w.t3.turns).toHaveLength(0);
    expect(w.server.t3Wake.uncertain(THREAD, replyId)).toBe(true);
    const line = w.logs.find((entry) => entry.includes("runtime_mode_escalation_denied"));
    expect(line).toContain(replyId);
    expect(line).toContain("(auto)");
    expect(line).toContain(`plannotator t3 login --url ${w.t3.endpoint.href}`);
    clock += 11 * 60_000;
    await w.server.t3Wake.sweep();
    expect(w.t3.sendCalls).toBe(1);
    expect(await w.server.t3Wake.wakes("t3", THREAD)).toBe(false);
    expect(w.server.t3Wake.status(THREAD)).toBeNull();
    const second = await w.send("And the TTL?");
    expect(second.text).toContain(INBOX_REPLY_READ_LATER_TEXT);
    await w.server.t3Wake.sweep();
    expect(w.t3.sendCalls).toBe(1);

    w.t3.state.deny = null;
    w.login("e2");
    const third = await w.send("Ready?");
    expect(third.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    await w.reply(third.message_id, "Go.", "k3");
    await w.server.t3Wake.sweep();
    expect(w.t3.turns.map((turn) => turn.message)).toEqual([expect.stringContaining("Go.")]);
  });

  test("a Read only grant (capability_denied) is named as read-only", async () => {
    const w = await loopback();
    const sent = await w.send("Which cache?");
    w.t3.state.deny = { code: "capability_denied", message: "This tool changes the environment, and this MCP client was approved for read-only access." };
    await w.reply(sent.message_id, "The edge one.", "k1");
    await w.server.t3Wake.sweep();
    expect(w.logs.find((entry) => entry.includes("capability_denied"))).toContain("(read-only)");
    expect(w.t3.sendCalls).toBe(1);
  });

  test("a grant T3 refuses (401) wakes nothing: the agent reads later, and nothing is sent", async () => {
    const w = await loopback({ token: "lapsed" });
    const sent = await w.send("Anyone there?");
    expect(sent.text).toContain(INBOX_REPLY_READ_LATER_TEXT);
    await w.reply(sent.message_id, "Here.", "k1");
    await w.server.t3Wake.sweep();
    expect(w.t3.sendCalls).toBe(0);
  });

  test("a grant that lapses after the agent sent: the reply waits, and the log asks for a login once", async () => {
    let clock = Date.now();
    const w = await loopback({ now: () => clock });
    const sent = await w.send("Anyone there?");
    expect(sent.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    w.t3.state.token = "revoked";
    await w.reply(sent.message_id, "Here.", "k1");
    await w.server.t3Wake.sweep();
    clock += 31_000;
    await w.server.t3Wake.sweep();
    await w.server.t3Wake.sweep();
    expect(w.t3.sendCalls).toBe(0);
    expect(w.logs.filter((entry) => entry.startsWith(`No T3 grant reaches thread ${THREAD}`) && entry.includes("plannotator t3 login"))).toHaveLength(1);
    expect(await w.server.t3Wake.wakes("t3", THREAD)).toBe(false);
  });

  test("the grant's mode in a denial line is T3's, an interaction mode named as one", () => {
    expect(t3GrantModeOf("T3 t3_thread_send: {\"code\":\"interaction_mode_escalation_denied\",\"message\":\"Child interaction mode default is broader than parent mode plan.\"}")).toBe("interaction mode plan");
    expect(t3GrantModeOf("Child runtime mode full-access is broader than parent mode auto.")).toBe("auto");
    expect(t3CeilingOfScope(t3ScopeOf("read-only"))).toBe("read-only");
    expect(t3CeilingOfScope(t3ScopeOf("auto"))).toBe("below-full-access");
    expect(t3CeilingOfScope(t3ScopeOf("full-access"))).toBe("full-access");
  });

  test("a Read only sign-in promises no wake, from the first message: nothing is sent and the log says why", async () => {
    const w = await loopback({ access: "read-only", scoped: true });
    const sent = await w.send("Which cache?");
    expect(sent.text).toContain(INBOX_REPLY_READ_LATER_TEXT);
    await w.reply(sent.message_id, "The edge one.", "k1");
    await w.server.t3Wake.sweep();
    expect(w.t3.sendCalls).toBe(0);
    expect(w.server.t3Wake.status(THREAD)).toBeNull();
    const line = w.logs.find((entry) => entry.includes(`cannot send into thread ${THREAD}`));
    expect(line).toContain("(read-only)");
    expect(line).toContain(`plannotator t3 login --url ${w.t3.endpoint.href}`);
  });

  test("a sign-in below Full access promises no wake into a Full access thread, from the first message", async () => {
    const w = await loopback({ access: "approval-required", scoped: true, modes: { [THREAD]: "full-access", [OTHER]: "approval-required" } });
    const sent = await w.send("Which cache?");
    expect(sent.text).toContain(INBOX_REPLY_READ_LATER_TEXT);
    await w.reply(sent.message_id, "The edge one.", "k1");
    await w.server.t3Wake.sweep();
    expect(w.t3.sendCalls).toBe(0);
    expect(w.logs.find((entry) => entry.includes(`cannot send into thread ${THREAD}`))).toContain("grant (below Full access) cannot send into thread");
    expect(w.logs.find((entry) => entry.includes(`cannot send into thread ${THREAD}`))).toContain("(it runs full-access)");
    const other = await w.send("And the TTL?", OTHER);
    expect(other.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    await w.reply(other.message_id, "An hour.", "k2");
    await w.server.t3Wake.sweep();
    expect(w.t3.turns.map((turn) => turn.threadId)).toEqual([OTHER]);
  });

  test("a sign-in saved without its scope learns its mode from T3's first denial, for every thread under it", async () => {
    for (const [access, modes] of [["read-only", {}], ["auto", { [THREAD]: "full-access", [OTHER]: "full-access" }]] as const) {
      const w = await loopback({ access, modes });
      const sent = await w.send("Which cache?");
      expect(sent.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
      await w.reply(sent.message_id, "The edge one.", "k1");
      await w.server.t3Wake.sweep();
      expect(w.t3.sendCalls).toBe(1);
      expect((await w.send("Second?", OTHER)).text).toContain(INBOX_REPLY_READ_LATER_TEXT);
      expect((await w.send("Third?")).text).toContain(INBOX_REPLY_READ_LATER_TEXT);
      await w.server.t3Wake.sweep();
      expect(w.t3.sendCalls).toBe(1);
    }
  });

  test("a T3 error on the lookup (orchestration_error) is not taken for a missing grant: no login line, and tried again", async () => {
    let clock = Date.now();
    const w = await loopback({ now: () => clock });
    const sent = await w.send("Which cache?");
    w.t3.state.token = "restarting";
    await w.reply(sent.message_id, "The edge one.", "k1");
    await w.server.t3Wake.sweep();
    w.t3.state.token = "t3-test-access";
    w.t3.state.readFailure = { code: "orchestration_error", message: "The operation could not be completed." };
    clock += 31_000;
    await w.server.t3Wake.sweep();
    expect(w.logs.some((entry) => entry.startsWith("No T3 grant reaches thread"))).toBe(false);
    expect(w.logs.some((entry) => entry.startsWith(`T3 could not be reached for thread ${THREAD}`))).toBe(true);
    w.t3.state.readFailure = null;
    clock += 61_000;
    await w.server.t3Wake.sweep();
    expect(w.t3.turns.map((turn) => turn.message)).toEqual([expect.stringContaining("The edge one.")]);
  });

  test("after `plannotator t3 logout`, a thread found before is no longer promised a wake", async () => {
    const w = await loopback();
    expect((await w.send("Which cache?")).text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    expect(w.server.t3Wake.status(THREAD)).toBe("alive");
    w.logout();
    expect(w.server.t3Wake.status(THREAD)).toBeNull();
    expect((await w.send("Still there?")).text).toContain(INBOX_REPLY_READ_LATER_TEXT);
  });

  test("a T3 that does not answer holds an agent's send_message only a few seconds, and is not promised", async () => {
    const w = await loopback({ lookupTimeoutMs: 300 });
    w.t3.state.stallMs = 5_000;
    const started = Date.now();
    const sent = await w.send("Which cache?");
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(sent.text).toContain(INBOX_REPLY_READ_LATER_TEXT);
    w.t3.state.stallMs = 0;
  });
});

test("a wake T3 Code holds in its queue never says nothing open, since the agent may ask first; the person's words stay", async () => {
  const w = await world();
  const sent = await w.send("A plain update.");
  await w.reply(sent.message_id, "Keep going, nothing open on my side.");
  await w.server.t3Wake.sweep();
  const text = String(w.t3.sends[0]!.message);
  expect(text.split("\n")[2]).toBe(`[Thread ${sent.thread_id}: 2 messages. Your last message was just now]`);
  expect(text.split("nothing open")).toHaveLength(2);
  expect(text).toContain("Keep going, nothing open on my side.");
});

test("a reply moved back to the T3 thread that took its stop notice goes in as its own request, and only that delivers it", async () => {
  const WORDS = "Yours again: use the ARM runner.";
  const clock = { now: Date.now() };
  const w = await world({ sessionsNow: () => clock.now });
  const sent = await w.send("Which runner?");
  const base = `http://127.0.0.1:${w.server.port}`;
  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`${base}/api/inbox/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: w.server.serverSession, ...body }) });
  await fetch(`${base}/api/inbox/bridge/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${w.server.token}` },
    body: JSON.stringify({ session: "session-new-owner", host: "pi", waitMs: 0, tags: true }),
  });
  const id = ((await (await post(`messages/${sent.message_id}/reply`, { idempotency_key: "k1", words: WORDS, tags: [{ host: "pi", session: "session-new-owner", mode: "handoff" }] })).json()) as { reply: { id: string } }).reply.id;
  const message = async () => (await w.thread(sent.thread_id)).messages.find((m) => m.id === id)!;
  for (let waited = 0; w.t3.sends.length === 0 && waited < 3_000; waited += 25) {
    await w.server.t3Wake.sweep();
    await Bun.sleep(25);
  }
  expect(w.t3.sends).toHaveLength(1);
  expect((await message()).tags?.[0]?.delivery).toBeTruthy();

  clock.now += INBOX_ASKER_RESTART_GRACE_MS + 1;
  await w.send("Still here.");
  expect((await post(`messages/${id}/to`, { to: { host: "t3", session: THREAD } })).status).toBe(200);
  await w.server.t3Wake.sweep();
  await w.server.t3Wake.sweep();

  expect(w.t3.sends).toHaveLength(2);
  expect(String(w.t3.sends[1]!.message)).toContain(WORDS);
  expect(w.t3.sends[1]!.clientRequestId).not.toBe(w.t3.sends[0]!.clientRequestId);
  expect((await message()).delivery).toMatchObject({ session: THREAD });
}, 30_000);
