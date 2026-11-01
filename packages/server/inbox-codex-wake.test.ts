/**
 * The Codex wake (inbox-codex-wake.ts), through the Inbox's real doors: a
 * Codex thread's send_message over MCP (the SDK client, with the `_meta`
 * Codex puts on every tool call), the person's reply route, the tag and New
 * message routes, and a fake `codex` on a scratch PATH that logs its argv
 * (tests/helpers/fake-agents.ts). The real Codex is never run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_CODEX_MESSAGE_MAX_BYTES, codexQueueMessage, codexWakeText } from "./inbox-codex-wake";
import { INBOX_TIDY_INSTRUCTION, codexCallWakes, codexCliQueues, codexThreadOfCall, codexTurnStartedAt, codexTurnTrigger, isCodexThreadId, parseCodexCliVersion, type InboxThread, type InboxTidyPlan } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_POLL_PATH,
  INBOX_MESSAGE_INSTRUCTION,
  INBOX_TAGGED_INSTRUCTION,
  INBOX_TAGS_POLL_FIELD,
  INBOX_WAKE_INSTRUCTION,
  inboxWakeText,
} from "@plannotator/shared/inbox/connection";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_REPLY_ARRIVES_TEXT, INBOX_REPLY_WAITS_TEXT } from "./inbox-mcp";

const THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const OTHER_THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5c";

const fakes: FakeAgents[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  // Throws when a fake CLI outlived the test.
  for (const fake of fakes.splice(0)) fake.remove();
});

interface World {
  fake: FakeAgents;
  dataDir: string;
  project: string;
  server: InboxServer;
  client: Client;
  start: () => Promise<InboxServer>;
}

async function world(options: { codex?: boolean; env?: Record<string, string> | ((root: string) => Record<string, string>); storeNow?: () => Date; queueTimeoutMs?: number; now?: () => number } = {}): Promise<World> {
  const fake = createFakeAgents("plannotator-codex-wake-");
  fakes.push(fake);
  if (options.codex !== false) fake.install("codex");
  const dataDir = join(fake.root, "data");
  const project = join(fake.root, "ledger");
  mkdirSync(project, { recursive: true });
  const extraEnv = typeof options.env === "function" ? options.env(fake.root) : options.env;
  const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...extraEnv } });
  const start = async () => {
    const server = await startInboxServer({
      dataDir,
      agentEnvironment: environment,
      codexWake: { extraClis: [], ...(options.queueTimeoutMs ? { queueTimeoutMs: options.queueTimeoutMs } : {}), ...(options.now ? { now: options.now } : {}) },
      ...(options.storeNow ? { storeNow: options.storeNow } : {}),
    });
    servers.push(server);
    return server;
  };
  const server = await start();
  const client = await connect(server);
  return { fake, dataDir, project, server, client, start };
}

async function connect(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "codex-mcp-client", version: "0.160.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

/** What Codex puts on every tool call (seen on codex-cli 0.160.0: `turn_trigger` is `user` in the TUI, `exec` in `codex exec`). */
function codexMeta(thread: string, turnStartedAt = Date.now(), trigger = "user") {
  return {
    threadId: thread,
    sessionId: thread,
    "x-codex-turn-metadata": { thread_id: thread, turn_started_at_unix_ms: turnStartedAt, turn_trigger: trigger, codex_version: "0.160.0" },
  };
}

/** A wake line as Codex reads it: its MCP tools by their own names. */
const asCodex = (line: string) => line.split("plannotator_inbox ").join("");

async function codexSends(client: Client, project: string, body: string, thread = THREAD, trigger = "user") {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: thread, agent_host: "codex", agent_name: "Codex" },
    _meta: codexMeta(thread, Date.now(), trigger),
  });
  const text = (result.content as { text: string }[])[0]!.text;
  return { ...(result.structuredContent as { message_id: string; thread_id: string }), text };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

function reply(server: InboxServer, messageId: string, body: Record<string, unknown>) {
  return fetch(`${base(server)}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

const queues = (fake: FakeAgents) => fake.calls().filter((call) => call.name === "codex" && call.args[0] === "queue");
const argOf = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

describe("the pure parts", () => {
  test("a thread id is a UUID; nothing else is ever handed to codex queue", () => {
    expect(isCodexThreadId(THREAD)).toBe(true);
    for (const bad of ["", "abc", `${THREAD} `, `-${THREAD.slice(1)}`, "--yolo", "ses_01ABC", `${THREAD}x`]) expect(isCodexThreadId(bad)).toBe(false);
  });

  test("codex queue needs Codex CLI 0.149 or later; the ChatGPT app's alpha versions count", () => {
    expect(parseCodexCliVersion("codex-cli 0.160.0\n")).toEqual([0, 160, 0]);
    expect(parseCodexCliVersion("codex-cli 0.164.0-alpha.11.1")).toEqual([0, 164, 0]);
    expect(parseCodexCliVersion("0.160.0")).toBeNull();
    expect(codexCliQueues([0, 149, 0])).toBe(true);
    expect(codexCliQueues([0, 148, 9])).toBe(false);
    expect(codexCliQueues([1, 0, 0])).toBe(true);
    expect(codexCliQueues(null)).toBe(false);
  });

  test("a call's thread is read only from Codex (its client name or its turn metadata)", () => {
    expect(codexThreadOfCall(codexMeta(THREAD))).toBe(THREAD);
    expect(codexThreadOfCall({ threadId: THREAD }, "codex-mcp-client")).toBe(THREAD);
    expect(codexThreadOfCall({ threadId: THREAD })).toBeNull();
    expect(codexThreadOfCall({ threadId: "abc" }, "codex-mcp-client")).toBeNull();
    expect(codexTurnStartedAt(codexMeta(THREAD, 1234))).toBe(1234);
    expect(codexTurnStartedAt({ threadId: THREAD })).toBeNull();
    expect(codexTurnTrigger(codexMeta(THREAD, 1, "exec"))).toBe("exec");
    // A `codex exec` run exits after its turn: it is never woken.
    expect(codexCallWakes(codexMeta(THREAD), THREAD)).toBe(true);
    expect(codexCallWakes(codexMeta(THREAD, 1, "exec"), THREAD)).toBe(false);
    expect(codexCallWakes(codexMeta(THREAD), OTHER_THREAD)).toBe(false);
    expect(codexCallWakes(undefined, THREAD)).toBe(false);
  });

  test("the wake names the tools as Codex lists them, and never touches the person's words", () => {
    const command = { type: "reply" as const, id: "msg_X", thread_id: "msg_T", reply_to: "msg_A", subject: "S", body: "Ask plannotator_inbox send_message to do it.", url: "u" };
    const text = codexWakeText(command);
    expect(text.split("\n")[1]).toBe(asCodex(INBOX_WAKE_INSTRUCTION));
    expect(text).toContain("answer in the same thread: send_message with reply_to");
    expect(text).toContain("more: read_thread");
    expect(text).toContain("Ask plannotator_inbox send_message to do it.");
    expect(text.replace(command.body, "")).not.toContain("plannotator_inbox");
  });

  test("a reply too long for one argument is cut on a character, with where the rest is", () => {
    const body = `${"é".repeat(INBOX_CODEX_MESSAGE_MAX_BYTES)}\u0000`;
    const text = codexQueueMessage({ type: "reply", id: "msg_X", thread_id: "msg_T", reply_to: "msg_A", subject: "S", body, url: "u" });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(INBOX_CODEX_MESSAGE_MAX_BYTES);
    expect(text).not.toContain("\u0000");
    expect(text).not.toContain("�");
    expect(text).toContain("read_thread with message_id msg_X");
    const short = { type: "reply" as const, id: "msg_X", thread_id: "msg_T", reply_to: "msg_A", subject: "S", body: "-- go", url: "u" };
    expect(codexQueueMessage(short)).toBe(codexWakeText(short));
    expect(codexQueueMessage(short)).toBe(asCodex(inboxWakeText(short)));
  });
});

describe("a reply to a Codex thread", () => {
  test("goes in once through codex queue, never twice across sweeps and restarts, and is delivered once the thread's next turn calls a tool", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Ship the worker today?");
    // It wakes: the agent is told to end its turn, and the message says so.
    expect(sent.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    const asked = (await thread(w.server, sent.thread_id)).messages[0]!;
    expect(asked.author).toMatchObject({ kind: "agent", host: "codex", session: THREAD });
    expect(asked.wakes).toBe(true);

    const before = Date.now();
    const response = await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Yes, ship it." });
    expect(response.status).toBe(200);
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    await w.server.codexWake.sweep();
    await w.server.codexWake.sweep();

    const calls = queues(w.fake);
    expect(calls).toHaveLength(1);
    expect(argOf(calls[0]!.args, "thread")).toBe(THREAD);
    const message = argOf(calls[0]!.args, "message")!;
    const lines = message.split("\n");
    expect(lines[0]).toBe(`Plannotator Inbox: a reply (${replyId})`);
    expect(lines[1]).toBe(asCodex(INBOX_WAKE_INSTRUCTION));
    expect(message).toContain("Yes, ship it.");
    // Every value goes as --name=value, so text that starts with "-" is never read as a flag.
    expect(calls[0]!.args).toEqual(["queue", `--thread=${THREAD}`, `--message=${message}`]);

    // The window: queued, as the next turn (no Send now: Codex never takes a message mid-turn).
    const sessions = (await (await fetch(`${base(w.server)}/api/inbox/threads/${sent.thread_id}/sessions?asker=${THREAD}`)).json()) as {
      asker: { live: boolean; connection: { busy: boolean | null; send_now: boolean } | null };
    };
    expect(sessions.asker.live).toBe(true);
    expect(sessions.asker.connection).toMatchObject({ busy: null, send_now: false });
    expect((await thread(w.server, sent.thread_id)).messages.at(-1)!.delivery ?? null).toBeNull();

    // A restart: the claim is on disk, so it is not queued again.
    w.server.stop();
    const again = await w.start();
    await again.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);

    // A tool call from a turn that started BEFORE it was queued (the turn already running) is not its delivery.
    const client = await connect(again);
    await client.callTool({ name: "read_thread", arguments: { agent_session: THREAD, thread_id: sent.thread_id }, _meta: codexMeta(THREAD, before - 10_000) });
    // read_thread reads it: the reply counts as read (pendingReplies settles), and the claim is done with.
    await again.codexWake.sweep();
    expect(existsSync(join(w.dataDir, "inbox", "codex-queue"))).toBe(true);
    expect(readdirSync(join(w.dataDir, "inbox", "codex-queue")).filter((name) => name !== "dead")).toEqual([]);
    expect(queues(w.fake)).toHaveLength(1);
  });

  test("a reply in a named thread is queued under the thread's short name, never its subject", async () => {
    const w = await world();
    const sent = (await w.client.callTool({
      name: "send_message",
      arguments: { body: "Quota is climbing.", subject: "Quota 93% used", thread: "Latest triage", project_path: w.project, agent_session: THREAD, agent_host: "codex", agent_name: "Codex" },
      _meta: codexMeta(THREAD),
    })).structuredContent as { message_id: string };
    const response = await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Check the cache." });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    await w.server.codexWake.sweep();
    const message = argOf(queues(w.fake)[0]!.args, "message")!;
    expect(message.split("\n")[0]).toBe(`Plannotator Inbox: Latest triage (${replyId})`);
    expect(message).not.toContain("Quota 93% used");
  });

  test("the next turn's first Inbox tool call records the delivery", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Which retry policy?");
    const response = await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Backoff." });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    await w.server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);
    // The woken turn answers with send_message: it started after the queue.
    await w.client.callTool({
      name: "send_message",
      arguments: { body: "Going with backoff.", reply_to: sent.message_id, agent_session: THREAD, agent_host: "codex" },
      _meta: codexMeta(THREAD, Date.now() + 5),
    });
    for (let waited = 0; waited < 2000; waited += 25) {
      if ((await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)?.delivery) break;
      await Bun.sleep(25);
    }
    const delivered = (await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)!;
    expect(delivered.delivery).toMatchObject({ state: "delivered", host: "codex", session: THREAD });
  });

  test("a turn that starts while codex queue is still running (an idle thread) and calls a tool records the delivery", async () => {
    const w = await world({ env: { FAKE_CODEX_QUEUE_DELAY_MS: "1500" } });
    const sent = await codexSends(w.client, w.project, "Which retry policy?");
    const response = await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Backoff." });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    const sweeping = w.server.codexWake.sweep();
    // Wait for the call to start, then the woken turn answers before it returns.
    for (let waited = 0; waited < 3000 && queues(w.fake).length === 0; waited += 25) await Bun.sleep(25);
    expect(queues(w.fake)).toHaveLength(1);
    await w.client.callTool({
      name: "send_message",
      arguments: { body: "Going with backoff.", reply_to: sent.message_id, agent_session: THREAD, agent_host: "codex" },
      _meta: codexMeta(THREAD, Date.now()),
    });
    // Not yet: the call has not said it queued.
    await Bun.sleep(100);
    expect((await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)!.delivery ?? null).toBeNull();
    // Once it exits 0, the turn that took it counts.
    await sweeping;
    expect((await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)!.delivery).toMatchObject({ host: "codex", session: THREAD });
    await w.server.codexWake.sweep();
    expect(readdirSync(join(w.dataDir, "inbox", "codex-queue"))).toEqual([]);
    expect(queues(w.fake)).toHaveLength(1);
  });

  test("a codex queue that hangs and runs out of time is never sent again and never marked delivered, across a restart; the line says saved", async () => {
    const w = await world();
    w.server.stop();
    const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: w.fake.home, env: { ...w.fake.env, FAKE_CODEX_QUEUE_DELAY_MS: "20000" } });
    const start = async () => {
      const server = await startInboxServer({ dataDir: w.dataDir, agentEnvironment: environment, codexWake: { extraClis: [], queueTimeoutMs: 400 } });
      servers.push(server);
      return server;
    };
    let server = await start();
    let client = await connect(server);
    const sent = await codexSends(client, w.project, "Ship it?");
    const response = await reply(server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    const before = Date.now();
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);
    // The hung call was killed (fake.remove() fails the test if it still runs).
    for (let waited = 0; waited < 2000 && w.fake.live().length > 0; waited += 50) await Bun.sleep(50);
    expect(w.fake.live()).toEqual([]);
    expect(server.codexWake.uncertain(THREAD, replyId)).toBe(true);

    const check = async (s: InboxServer, c: Client) => {
      // The thread's next turn calls a tool: it may never have got the reply, so that is no delivery.
      await c.callTool({ name: "search", arguments: { query: "ship", project_path: w.project }, _meta: codexMeta(THREAD, Date.now() + 5) });
      await Bun.sleep(150);
      expect((await thread(s, sent.thread_id)).messages.find((m) => m.id === replyId)!.delivery ?? null).toBeNull();
      // Its line and its row say saved, not queued.
      const sessions = (await (await fetch(`${base(s)}/api/inbox/threads/${sent.thread_id}/sessions?asker=${THREAD}`)).json()) as { asker: { connection: { uncertain?: string[] } | null } };
      expect(sessions.asker.connection?.uncertain).toEqual([replyId]);
      const rows = (await (await fetch(`${base(s)}/api/inbox/threads`)).json()) as { sections: { threads: { thread_id: string; delivery: { state: string; reason: string } | null }[] }[] };
      expect(rows.sections.flatMap((section) => section.threads).find((t) => t.thread_id === sent.thread_id)!.delivery).toMatchObject({ state: "saved", reason: "reads" });
      // And it is never sent again.
      await s.codexWake.sweep();
      expect(queues(w.fake)).toHaveLength(1);
    };
    await check(server, client);
    expect(before).toBeLessThan(Date.now());

    // A restart reads the claim back as uncertain, not as queued.
    server.stop();
    server = await start();
    client = await connect(server);
    expect(server.codexWake.uncertain(THREAD, replyId)).toBe(true);
    await check(server, client);

    // The agent reads the thread: the reply is settled the ordinary way, and the claim is done with.
    await client.callTool({ name: "read_thread", arguments: { agent_session: THREAD, thread_id: sent.thread_id }, _meta: codexMeta(THREAD) });
    await server.codexWake.sweep();
    expect(server.codexWake.uncertain(THREAD, replyId)).toBe(false);
    expect(readdirSync(join(w.dataDir, "inbox", "codex-queue"))).toEqual([]);
  }, 30_000);

  test("a turn during a codex queue that then fails is no delivery: the reply is tried again", async () => {
    const w = await world();
    const failFile = join(w.fake.root, "fail");
    writeFileSync(failFile, "1");
    w.server.stop();
    let clock = Date.now();
    const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: w.fake.home, env: { ...w.fake.env, FAKE_CODEX_QUEUE_FAIL_FILE: failFile, FAKE_CODEX_QUEUE_DELAY_MS: "800" } });
    const server = await startInboxServer({ dataDir: w.dataDir, agentEnvironment: environment, codexWake: { extraClis: [], now: () => clock } });
    servers.push(server);
    const client = await connect(server);
    const sent = await codexSends(client, w.project, "Ship it?");
    const response = await reply(server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    const sweeping = server.codexWake.sweep();
    for (let waited = 0; waited < 3000 && queues(w.fake).length === 0; waited += 25) await Bun.sleep(25);
    // A turn of that thread calls a tool while the call runs (it started after the queue began).
    await client.callTool({ name: "read_thread", arguments: { agent_session: THREAD }, _meta: codexMeta(THREAD, clock + 1) });
    await sweeping;
    expect((await thread(server, sent.thread_id)).messages.find((m) => m.id === replyId)!.delivery ?? null).toBeNull();
    writeFileSync(failFile, "");
    clock += 31_000;
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(2);
  });

  test("a tool call with no session (search) from the thread's next turn still records the delivery", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Which retry policy?");
    const response = await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Backoff." });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    await w.server.codexWake.sweep();
    await w.client.callTool({ name: "search", arguments: { query: "retry", project_path: w.project }, _meta: codexMeta(THREAD, Date.now() + 5) });
    for (let waited = 0; waited < 2000; waited += 25) {
      if ((await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)?.delivery) break;
      await Bun.sleep(25);
    }
    expect((await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)!.delivery).toMatchObject({ host: "codex", session: THREAD });
  });

  test("a codex exec run is never woken: its agent is told to wait_for_reply, it is not live, and nothing is queued", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Ship it?", THREAD, "exec");
    expect(sent.text).toContain(INBOX_REPLY_WAITS_TEXT);
    expect((await thread(w.server, sent.thread_id)).messages[0]!.wakes).toBeUndefined();
    await Bun.sleep(100);
    const sessions = (await (await fetch(`${base(w.server)}/api/inbox/threads/${sent.thread_id}/sessions`)).json()) as { sessions: { session: string }[] };
    expect(sessions.sessions.map((s) => s.session)).not.toContain(THREAD);
    await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    await w.server.codexWake.sweep();
    expect(queues(w.fake)).toEqual([]);
    expect(w.server.codexWake.status(THREAD)).toBeNull();
  });

  /** What a command the thread's shell runs sends (`plannotator inbox call`): its session, no Codex `_meta`. */
  const fromShell = (client: Client, project: string, args: Record<string, unknown>, session = THREAD) =>
    client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: session, agent_host: "codex", agent_name: "Codex", ...args } }) as Promise<{ content: { text: string }[]; structuredContent: { message_id: string; thread_id: string } }>;

  test("a command a woken thread's shell runs is that thread: its message wakes, and the person's reply to it goes in", async () => {
    const w = await world();
    await codexSends(w.client, w.project, "Starting.");
    const sent = await fromShell(w.client, w.project, { body: "From a script." });
    expect(sent.content[0]!.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    expect((await thread(w.server, sent.structuredContent.thread_id)).messages.at(-1)!.wakes).toBe(true);
    await reply(w.server, sent.structuredContent.message_id, { idempotency_key: "k1", words: "Thanks." });
    await w.server.codexWake.sweep();
    expect(argOf(queues(w.fake)[0]!.args, "message")).toContain("Thanks.");
    // A reply stays queued until a turn says it reached the thread: a command names no turn.
    await fromShell(w.client, w.project, { body: "Still working." });
    await Bun.sleep(50);
    const reachedIt = (await thread(w.server, sent.structuredContent.thread_id)).messages.find((m) => m.author.kind === "person");
    expect(reachedIt!.delivery ?? null).toBeNull();
  });

  test("a shell's command never makes a thread wake that was not woken: one the Inbox never woke, a codex exec run", async () => {
    const w = await world();
    const unknown = await fromShell(w.client, w.project, { body: "Who is this?" });
    expect(unknown.content[0]!.text).toContain(INBOX_REPLY_WAITS_TEXT);
    await codexSends(w.client, w.project, "One turn only.", OTHER_THREAD, "exec");
    expect((await fromShell(w.client, w.project, { body: "Still one turn." }, OTHER_THREAD)).content[0]!.text).toContain(INBOX_REPLY_WAITS_TEXT);
  });

  test("a Tidy a woken thread answers from a script counts: the command says the wake arrived, and its writes are tidied", async () => {
    const clock = { behind: 3 * 60 * 60_000 };
    const w = await world({ storeNow: () => new Date(Date.now() - clock.behind) });
    const asked = await codexSends(w.client, w.project, ":::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::");
    clock.behind = 0;
    const tidy = await fetch(`${base(w.server)}/api/inbox/tidy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: w.server.serverSession, sessions: [THREAD], idempotency_key: "t1" }) });
    expect(tidy.status).toBe(200);
    await w.server.codexWake.sweep();
    expect(argOf(queues(w.fake)[0]!.args, "message")).toContain(`--session codex:${THREAD}`);
    const stateOf = async () => ((await (await fetch(`${base(w.server)}/api/inbox/tidy`)).json()) as InboxTidyPlan).run!.agents[0]!;
    expect((await stateOf()).state).toBe("waiting");
    // The agent read the wake as a turn: a script's result never carries it a second time.
    const first = await fromShell(w.client, w.project, { reply_to: asked.message_id, body: "That one no longer applies.", idempotency_key: "s1" });
    expect(first.content[0]!.text).not.toContain("Tidy");
    await Bun.sleep(5);
    await fromShell(w.client, w.project, { reply_to: asked.message_id, body: "Nothing else to do here.", idempotency_key: "s2" });
    expect(await stateOf()).toMatchObject({ state: "tidied", updated: 1 });
  });

  test("an open wait on one thread holds back only that thread's reply; another thread's reply to the same session is queued", async () => {
    const w = await world();
    const a = await codexSends(w.client, w.project, "A?");
    const b = await w.client.callTool({
      name: "send_message",
      arguments: { body: "B?", project_path: w.project, agent_session: THREAD, agent_host: "codex", thread: "other work" },
      _meta: codexMeta(THREAD),
    });
    const bSent = b.structuredContent as { message_id: string; thread_id: string };
    expect(bSent.thread_id).not.toBe(a.thread_id);
    const waiting = w.client.callTool({ name: "wait_for_reply", arguments: { agent_session: THREAD, thread_id: a.thread_id, timeout_seconds: 3 }, _meta: codexMeta(THREAD) });
    await Bun.sleep(200);
    await reply(w.server, bSent.message_id, { idempotency_key: "kb", words: "for B" });
    await w.server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);
    expect(argOf(queues(w.fake)[0]!.args, "message")).toContain("for B");
    await waiting;
  });

  test("a thread blocked in wait_for_reply gets the reply from that call, and it is not queued as a turn as well", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Ship it?");
    const waiting = w.client.callTool({ name: "wait_for_reply", arguments: { agent_session: THREAD, thread_id: sent.thread_id, timeout_seconds: 20 }, _meta: codexMeta(THREAD) });
    await Bun.sleep(200);
    await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    const answer = (await waiting).structuredContent as { status: string };
    expect(answer.status).toBe("replied");
    await w.server.codexWake.sweep();
    expect(queues(w.fake)).toEqual([]);
  });

  test("without a Codex CLI that queues, nothing wakes: the message is MCP-only and nothing is run", async () => {
    for (const w of [await world({ codex: false }), await world({ env: { FAKE_CODEX_VERSION: "codex-cli 0.148.0" } })]) {
      const sent = await codexSends(w.client, w.project, "Ship it?");
      expect(sent.text).toContain(INBOX_REPLY_WAITS_TEXT);
      expect((await thread(w.server, sent.thread_id)).messages[0]!.wakes).toBeUndefined();
      await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
      await w.server.codexWake.sweep();
      expect(queues(w.fake)).toEqual([]);
      expect(w.server.codexWake.status(THREAD)).toBeNull();
    }
  });

  test("a thread Codex does not know is ended: the reply is saved for the next agent, and it is woken again once the thread is back", async () => {
    const w = await world();
    const unknown = join(w.fake.root, "unknown-threads");
    writeFileSync(unknown, THREAD);
    // The env is the server's, fixed at start: point the fake at the file.
    w.server.stop();
    const fake = w.fake;
    const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, FAKE_CODEX_UNKNOWN_FILE: unknown } });
    const server = await startInboxServer({ dataDir: w.dataDir, agentEnvironment: environment, codexWake: { extraClis: [] } });
    servers.push(server);
    const client = await connect(server);
    const sent = await codexSends(client, w.project, "Ship it?");
    await reply(server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    await server.codexWake.sweep();
    await server.codexWake.sweep();
    expect(queues(fake)).toHaveLength(1);
    expect(server.codexWake.status(THREAD)).toBe("dead");
    const sessions = (await (await fetch(`${base(server)}/api/inbox/threads/${sent.thread_id}/sessions?asker=${THREAD}`)).json()) as { asker: { live: boolean } };
    expect(sessions.asker.live).toBe(false);
    // The row says so: saved, because the session that asked has ended.
    const rows = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: { thread_id: string; delivery: { state: string; reason: string } | null }[] }[] };
    const row = rows.sections.flatMap((section) => section.threads).find((t) => t.thread_id === sent.thread_id)!;
    expect(row.delivery).toMatchObject({ state: "saved", reason: "ended" });

    // The thread comes back (resumed under this Codex): its next tool call clears it, and the reply goes.
    writeFileSync(unknown, "");
    await client.callTool({ name: "read_thread", arguments: { agent_session: THREAD, thread_id: sent.thread_id, format: "full" }, _meta: codexMeta(THREAD) });
    expect(server.codexWake.status(THREAD)).toBe("alive");
  });

  test("another failure is tried again later, and goes once it works", async () => {
    const w = await world();
    const failFile = join(w.fake.root, "fail");
    writeFileSync(failFile, "1");
    w.server.stop();
    const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: w.fake.home, env: { ...w.fake.env, FAKE_CODEX_QUEUE_FAIL_FILE: failFile } });
    let clock = Date.now();
    const server = await startInboxServer({ dataDir: w.dataDir, agentEnvironment: environment, codexWake: { extraClis: [], now: () => clock } });
    servers.push(server);
    const client = await connect(server);
    const sent = await codexSends(client, w.project, "Ship it?");
    await reply(server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);
    expect(server.codexWake.status(THREAD)).toBe("alive");
    // Within the back-off nothing runs.
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);
    // After it, it is tried again (still failing), then the wait doubles.
    clock += 31_000;
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(2);
    clock += 31_000;
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(2);
    // Codex works again: it goes, once.
    writeFileSync(failFile, "");
    clock += 61_000;
    await server.codexWake.sweep();
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(3);
    clock += 10 * 60_000;
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(3);
  });
});

describe("a Tidy through the Codex wake", () => {
  const QUESTION = ":::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::";
  const fromShell = (client: Client, project: string, args: Record<string, unknown>) =>
    client.callTool({ name: "send_message", arguments: { project_path: project, agent_session: THREAD, agent_host: "codex", agent_name: "Codex", ...args } }) as Promise<{ content: { text: string }[]; structuredContent: { message_id: string } }>;

  /** A question old enough to Tidy, then the Tidy; `file` holds what the fake `codex` reads from its `flag` file. */
  async function tidied(options: { codex?: boolean; env?: (root: string) => Record<string, string>; file?: string; now?: () => number; queueTimeoutMs?: number; trigger?: string } = {}) {
    const clock = { behind: 3 * 60 * 60_000 };
    const w = await world({ ...options, storeNow: () => new Date(Date.now() - clock.behind) });
    if (options.file) writeFileSync(join(w.fake.root, "flag"), options.file);
    const asked = await codexSends(w.client, w.project, QUESTION, THREAD, options.trigger);
    clock.behind = 0;
    const started = await fetch(`${base(w.server)}/api/inbox/tidy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: w.server.serverSession, sessions: [THREAD], idempotency_key: "t1" }) });
    expect(started.status).toBe(200);
    await w.server.codexWake.sweep();
    const note = (await thread(w.server, asked.thread_id)).messages.find((m) => m.tidy)!;
    const read = async (turnStartedAt = Date.now() + 5) => {
      const result = (await w.client.callTool({ name: "read_thread", arguments: { agent_session: THREAD, thread_id: asked.thread_id }, _meta: codexMeta(THREAD, turnStartedAt) })) as { content: { text: string }[]; structuredContent: { tidy?: { id: string } } };
      return { text: result.content.map((part) => part.text).join("\n"), tidy: result.structuredContent.tidy };
    };
    const state = async () => ((await (await fetch(`${base(w.server)}/api/inbox/tidy`)).json()) as InboxTidyPlan).run!.agents[0]!.state;
    return { ...w, asked, note, read, state };
  }

  const STUCK: [string, Parameters<typeof tidied>[0]][] = [
    ["codex queue ran out of time", { env: () => ({ FAKE_CODEX_QUEUE_DELAY_MS: "20000" }), queueTimeoutMs: 400 }],
    ["codex queue keeps failing", { env: (root) => ({ FAKE_CODEX_QUEUE_FAIL_FILE: join(root, "flag") }), file: "1" }],
    ["Codex does not know the thread", { env: (root) => ({ FAKE_CODEX_UNKNOWN_FILE: join(root, "flag") }), file: THREAD }],
  ];
  for (const [name, options] of STUCK) {
    test(`${name}: the thread's next read hands the Tidy over, once`, async () => {
      const t = await tidied(options);
      // The hung call was killed (fake.remove() fails the test if it still runs).
      for (let waited = 0; waited < 2000 && t.fake.live().length > 0; waited += 50) await Bun.sleep(50);
      expect(await t.state()).toBe("waiting");
      const first = await t.read();
      expect(first.text).toContain(INBOX_TIDY_INSTRUCTION);
      expect(first.tidy?.id).toBe(t.note.id);
      expect(await t.state()).toBe("delivered");
      expect((await t.read()).tidy).toBeUndefined();
      await t.server.codexWake.sweep();
    });
  }

  test("a queued wake: a read in the turn already running still hands the Tidy over, since a queue may never become a turn", async () => {
    const t = await tidied();
    expect(queues(t.fake)).toHaveLength(1);
    expect((await t.read(Date.now() - 60_000)).tidy?.id).toBe(t.note.id);
    expect(await t.state()).toBe("delivered");
    expect((await t.read()).tidy).toBeUndefined();
  });

  test("no Codex CLI when the Tidy landed, one found later: a read hands it over", async () => {
    const clock = { ahead: 0 };
    const t = await tidied({ codex: false, now: () => Date.now() + clock.ahead });
    expect(queues(t.fake)).toHaveLength(0);
    t.fake.install("codex");
    // Past the 60 s the empty answer is kept, so this call's own wake check finds the CLI.
    clock.ahead = 61_000;
    expect(await t.server.codexWake.cli()).not.toBeNull();
    expect((await t.read()).tidy?.id).toBe(t.note.id);
    expect(await t.state()).toBe("delivered");
    await t.server.codexWake.sweep();
  });

  test("a disowned thread back in a real turn: its first write stays clean, and the wake queues the Tidy once", async () => {
    const t = await tidied({ env: (root) => ({ FAKE_CODEX_UNKNOWN_FILE: join(root, "flag") }), file: THREAD });
    expect(t.server.codexWake.status(THREAD)).toBe("dead");
    const before = queues(t.fake).length;
    writeFileSync(join(t.fake.root, "flag"), "");
    const write = await codexSends(t.client, t.project, "Back on it.");
    expect(write.text).not.toContain(INBOX_TIDY_INSTRUCTION);
    await t.server.codexWake.sweep();
    expect(queues(t.fake)).toHaveLength(before + 1);
    expect(queues(t.fake).at(-1)!.args.find((arg) => arg.includes(INBOX_TIDY_INSTRUCTION))).toBeDefined();
  });

  test("a codex exec thread a Tidy named is still not a thread that wakes: its shell's message says to wait", async () => {
    const t = await tidied({ trigger: "exec" });
    const sent = await fromShell(t.client, t.project, { reply_to: t.asked.message_id, body: "From a script." });
    expect(sent.content[0]!.text).toContain(INBOX_REPLY_WAITS_TEXT);
    expect((await thread(t.server, t.asked.thread_id)).messages.find((m) => m.id === sent.structuredContent.message_id)!.wakes).toBeUndefined();
  });

  test("a thread Codex disowned does not wake from its shell, until a turn of its own says it is back", async () => {
    const w = await world({ env: (root) => ({ FAKE_CODEX_UNKNOWN_FILE: join(root, "flag") }) });
    writeFileSync(join(w.fake.root, "flag"), THREAD);
    const sent = await codexSends(w.client, w.project, "Ship it?");
    await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    await w.server.codexWake.sweep();
    expect(w.server.codexWake.status(THREAD)).toBe("dead");
    const wakesOf = async (result: { structuredContent: { message_id: string } }) => (await thread(w.server, sent.thread_id)).messages.find((m) => m.id === result.structuredContent.message_id)!.wakes;

    const script = await fromShell(w.client, w.project, { body: "From a script." });
    expect(script.content[0]!.text).toContain(INBOX_REPLY_WAITS_TEXT);
    expect(await wakesOf(script)).toBeUndefined();
    await w.server.codexWake.sweep();

    writeFileSync(join(w.fake.root, "flag"), "");
    await w.client.callTool({ name: "read_thread", arguments: { agent_session: THREAD, thread_id: sent.thread_id }, _meta: codexMeta(THREAD) });
    const back = await fromShell(w.client, w.project, { body: "Back." });
    expect(back.content[0]!.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    expect(await wakesOf(back)).toBe(true);
  });
});

describe("Settings → Agents: whether the Inbox can wake Codex", () => {
  const codexRow = async (server: InboxServer) => {
    const model = (await (await fetch(`${base(server)}/api/inbox/agents`)).json()) as { agents: { id: string; wakes?: boolean; reach: { kind: string; on: boolean } }[] };
    return model.agents.find((agent) => agent.id === "codex")!;
  };
  const connectCodex = (fake: FakeAgents) => {
    mkdirSync(join(fake.home, ".codex"), { recursive: true });
    writeFileSync(join(fake.home, ".codex", "config.toml"), '[mcp_servers.plannotator-inbox]\ncommand = "plannotator"\nargs = ["inbox", "mcp"]\n');
  };

  test("a connected Codex that queues wakes; one before 0.149 does not; a row that is not connected says nothing", async () => {
    const w = await world();
    expect((await codexRow(w.server)).wakes).toBeUndefined();
    connectCodex(w.fake);
    const row = await codexRow(w.server);
    expect(row.reach).toMatchObject({ kind: "mcp", on: true });
    expect(row.wakes).toBe(true);
    const old = await world({ env: { FAKE_CODEX_VERSION: "codex-cli 0.148.0" } });
    connectCodex(old.fake);
    expect((await codexRow(old.server)).wakes).toBe(false);
  });
});

describe("tags and New message", () => {
  test("a Codex thread tagged in a Claude Code thread gets the tagged wake once; the owner is untouched", async () => {
    const w = await world();
    // The Codex thread is seen (its tool call): live, taggable, woken.
    await codexSends(w.client, w.project, "Working on the ledger.");
    const owner = (await w.client.callTool({
      name: "send_message",
      arguments: { body: "Which retry policy?", project_path: w.project, agent_session: "ses-claude", agent_host: "claude-code", agent_name: "Claude Code" },
    })).structuredContent as { message_id: string; thread_id: string };
    // The owner's connection polls (it understands tags).
    await fetch(`${base(w.server)}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${w.server.token}` },
      body: JSON.stringify({ session: "ses-claude", host: "claude-code", project_path: w.project, waitMs: 0, [INBOX_TAGS_POLL_FIELD]: true }),
    });
    const response = await reply(w.server, owner.message_id, { idempotency_key: "k1", words: "@Codex check this too.", tags: [{ host: "codex", session: THREAD }] });
    expect(response.status).toBe(200);
    await w.server.codexWake.sweep();
    const calls = queues(w.fake);
    expect(calls).toHaveLength(1);
    expect(argOf(calls[0]!.args, "thread")).toBe(THREAD);
    const lines = argOf(calls[0]!.args, "message")!.split("\n");
    expect(lines[1]).toBe(asCodex(INBOX_TAGGED_INSTRUCTION));
  });

  test("New message to a live Codex thread is queued with the New message wake", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Working on the ledger.");
    const sessions = (await (await fetch(`${base(w.server)}/api/inbox/threads/${sent.thread_id}/sessions`)).json()) as { sessions: { session: string; host: string }[] };
    expect(sessions.sessions).toContainEqual(expect.objectContaining({ session: THREAD, host: "codex" }));
    const response = await fetch(`${base(w.server)}/api/inbox/threads/${sent.thread_id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: w.server.serverSession, session: THREAD, body: "Also bump the version.", idempotency_key: "m1" }),
    });
    expect(response.status).toBe(200);
    await w.server.codexWake.sweep();
    const calls = queues(w.fake);
    expect(calls).toHaveLength(1);
    expect(argOf(calls[0]!.args, "message")!.split("\n")[1]).toBe(asCodex(INBOX_MESSAGE_INSTRUCTION));
  });

  test("two threads each get their own reply, and only theirs", async () => {
    const w = await world();
    const a = await codexSends(w.client, w.project, "A?", THREAD);
    const b = await codexSends(w.client, w.project, "B?", OTHER_THREAD);
    await reply(w.server, a.message_id, { idempotency_key: "ka", words: "for A" });
    await reply(w.server, b.message_id, { idempotency_key: "kb", words: "for B" });
    await w.server.codexWake.sweep();
    const calls = queues(w.fake).map((call) => ({ thread: argOf(call.args, "thread"), message: argOf(call.args, "message")! }));
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.thread === THREAD)!.message).toContain("for A");
    expect(calls.find((c) => c.thread === OTHER_THREAD)!.message).toContain("for B");
    expect(calls.find((c) => c.thread === THREAD)!.message).not.toContain("for B");
  });
});
