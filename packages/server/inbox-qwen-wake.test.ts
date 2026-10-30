/**
 * The Qwen Code wake (inbox-qwen-wake.ts), through the Inbox's real doors: a
 * Qwen session's send_message over MCP, the person's reply route, and a fake
 * Qwen session made of a socket this test owns and a registry record in a
 * scratch Qwen home, speaking Qwen's cross-session protocol (auth line, user
 * frame, delivery receipts). The trusted-sender token comes from a fake
 * `qwen` (tests/helpers/fake-agents.ts). The real qwen is never run, and the
 * real ~/.qwen never read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_WAKE_INSTRUCTION } from "@plannotator/shared/inbox/connection";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_REPLY_ARRIVES_TEXT, INBOX_REPLY_WAITS_TEXT } from "./inbox-mcp";
import { ensureQwenTrust, qwenWakeToken, readQwenTrust, setQwenTrust } from "./inbox-qwen-trust";
import { qwenRecordLive, qwenSettingsKeepOut, type QwenAgentsSettings } from "./inbox-qwen-wake";

const SESSION = "8e016be8-5b48-4c13-ad22-1f5326ae64ac";

const fakes: FakeAgents[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const sockets: Server[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const socket of sockets.splice(0)) socket.close();
  for (const fake of fakes.splice(0)) fake.remove();
});

/**
 * Linux's record guards for this process, as Qwen writes them; null elsewhere.
 * The pid namespace is read in another process (`readlink` names it
 * `pid:[<inode>]`, the namespace's own inode, which Qwen records), so a value
 * that differs per process could never match.
 */
function identity(pid: number): { procStart: string | null; pidNs: number | null } {
  if (process.platform !== "linux") return { procStart: null, pidNs: null };
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const link = Bun.spawnSync(["readlink", "/proc/self/ns/pid"]).stdout.toString().trim();
  const pidNs = Number(/^pid:\[(\d+)\]$/.exec(link)?.[1]);
  expect(Number.isSafeInteger(pidNs)).toBe(true);
  return { procStart: `${boot}:${ticks}`, pidNs };
}

type Receipt = "delivered" | "held" | "refused" | "denied" | "misaddressed" | "dropped" | "expired" | null;

interface FakeSession {
  /** What came in on each connection: its lines, parsed. */
  received: { auth: Record<string, unknown>; frame: Record<string, unknown> }[];
  /** The receipt the next frames get (null: none). */
  answer: Receipt;
  ipcPath: string;
  ipcToken: string;
  /** Send a receipt for a frame now (as Qwen does when a held message is decided, or expires). */
  receipt(frame: Record<string, unknown>, status: Exclude<Receipt, null>): Promise<void>;
  /** (Re)write the record: this session, at this pid, of this kind. */
  register(record?: Partial<{ sessionId: string; pid: number; kind: string; ipcPath: string | null; file: string }>): void;
  unregister(): void;
}

interface World {
  fake: FakeAgents;
  dataDir: string;
  project: string;
  qwenHome: string;
  server: InboxServer;
  client: Client;
  session: FakeSession;
  start: (knobs?: Record<string, unknown>) => Promise<InboxServer>;
}

/** Send one receipt to the sender's socket, authenticated with the token its frame carried (Qwen's protocol §5). */
function sendReceipt(frame: Record<string, unknown>, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  return new Promise((done) => {
    const socket = createConnection({ path: frame.from as string });
    socket.on("connect", () => {
      socket.end(
        `${JSON.stringify({ msgV: 1, type: "auth", token: frame.replyToken })}\n${JSON.stringify({ msgV: 1, msgId: crypto.randomUUID(), type: "control", action: "delivery_status", status, origMsgId: frame.msgId, ...extra })}\n`,
      );
    });
    socket.on("close", () => done());
    socket.on("error", () => done());
  });
}

async function fakeSession(fake: FakeAgents, qwenHome: string, project: string): Promise<FakeSession> {
  const ipcPath = join(fake.root, "s.sock");
  const ipcToken = "c0ffee".padEnd(64, "0");
  const grants = () => {
    try {
      return (JSON.parse(readFileSync(join(qwenHome, "peer-controllers.json"), "utf8")) as { controllers: { token: string }[] }).controllers.map((g) => g.token);
    } catch {
      return [];
    }
  };
  const session: FakeSession = {
    received: [],
    answer: "delivered",
    ipcPath,
    ipcToken,
    receipt: (frame, status) => sendReceipt(frame, status),
    register: (record = {}) => {
      const pid = record.pid ?? process.pid;
      mkdirSync(join(qwenHome, "sessions"), { recursive: true });
      const file = record.file ?? `${pid}.json`;
      writeFileSync(
        join(qwenHome, "sessions", file),
        JSON.stringify({
          schemaVersion: 1,
          pid,
          ...identity(pid === process.pid ? pid : process.pid),
          sessionId: record.sessionId ?? SESSION,
          cwd: project,
          name: "ledger-8e",
          startedAt: Date.now(),
          qwenVersion: "0.26.2",
          kind: record.kind ?? "tui",
          ...(record.ipcPath === null ? {} : { ipcPath: record.ipcPath ?? ipcPath }),
          ipcToken,
        }),
      );
    },
    unregister: () => rmSync(join(qwenHome, "sessions"), { recursive: true, force: true }),
  };
  const server = createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (text += chunk));
    socket.on("end", () => {
      socket.end();
      const [auth, frame] = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      // An unknown token drops the connection without a word, as Qwen's inbox does.
      if (!auth || !frame || auth.type !== "auth" || !grants().includes(auth.token as string)) return;
      session.received.push({ auth, frame });
      if (session.answer) void sendReceipt(frame, session.answer);
    });
  });
  sockets.push(server);
  await new Promise<void>((done) => server.listen(ipcPath, () => done()));
  session.register();
  return session;
}

async function world(options: { trust?: boolean; env?: Record<string, string>; knobs?: Record<string, unknown> } = {}): Promise<World> {
  const fake = createFakeAgents("plannotator-qwen-wake-");
  fakes.push(fake);
  fake.install("qwen");
  const dataDir = join(fake.root, "data");
  const project = join(fake.root, "ledger");
  mkdirSync(project, { recursive: true });
  const qwenHome = join(fake.home, ".qwen");
  const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: fake.home, env: { ...fake.env, ...options.env } });
  if (options.trust !== false) expect((await ensureQwenTrust(dataDir, environment)).kind).toBe("added");
  const session = await fakeSession(fake, qwenHome, project);
  const start = async (knobs: Record<string, unknown> = {}) => {
    const server = await startInboxServer({ dataDir, agentEnvironment: environment, codexWake: { extraClis: [] }, qwenWake: { receiptTimeoutMs: 1_000, ...options.knobs, ...knobs } });
    servers.push(server);
    return server;
  };
  const server = await start();
  const client = await connect(server);
  return { fake, dataDir, project, qwenHome, server, client, session, start };
}

async function connect(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "qwen-cli-mcp-client-plannotator-inbox", version: "0.26.2" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

async function qwenSends(client: Client, project: string, body: string, session = SESSION, meta?: Record<string, unknown>) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: "qwen", agent_name: "Qwen Code" },
    ...(meta ? { _meta: meta } : {}),
  });
  const text = (result.content as { text: string }[])[0]!.text;
  return { ...(result.structuredContent as { message_id: string; thread_id: string }), text };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function reply(server: InboxServer, messageId: string, words: string): Promise<string> {
  const response = await fetch(`${base(server)}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k-${words}`, words }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { reply: { id: string } }).reply.id;
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

async function asker(server: InboxServer, threadId: string, session = SESSION) {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}/sessions?asker=${session}`)).json()) as { asker: { live: boolean; connection: { uncertain?: string[] } | null } }).asker;
}

async function until(check: () => boolean | Promise<boolean>, ms = 3_000) {
  for (let waited = 0; waited < ms; waited += 25) {
    if (await check()) return;
    await Bun.sleep(25);
  }
}

const claims = (w: World) => (existsSync(join(w.dataDir, "inbox", "qwen-wake")) ? readdirSync(join(w.dataDir, "inbox", "qwen-wake")) : []);

describe("a reply to a running Qwen Code session", () => {
  test("goes in once over the session's socket: the trusted token's auth line, then one frame naming the session; never twice across sweeps and restarts; delivered at its next tool call", async () => {
    const w = await world();
    const sent = await qwenSends(w.client, w.project, "Ship the worker today?");
    expect(sent.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    expect((await thread(w.server, sent.thread_id)).messages[0]!).toMatchObject({ author: { host: "qwen", session: SESSION }, wakes: true });

    const replyId = await reply(w.server, sent.message_id, "Yes, ship it.");
    await w.server.qwenWake.sweep();
    await until(() => w.session.received.length > 0);
    await w.server.qwenWake.sweep();
    expect(w.session.received).toHaveLength(1);
    const { auth, frame } = w.session.received[0]!;
    expect(auth).toEqual({ msgV: 1, type: "auth", token: readQwenTrust(w.dataDir)!.token });
    expect(frame).toMatchObject({ msgV: 1, type: "user", toSessionId: SESSION, priority: "next", fromName: "Plannotator Inbox", message: { role: "user" } });
    expect(frame.msgId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof frame.replyToken).toBe("string");
    const content = (frame.message as { content: string }).content;
    expect(content.split("\n")[0]).toBe(`Plannotator Inbox: Ship the worker today? (${replyId})`);
    expect(content.split("\n")[1]).toBe(INBOX_WAKE_INSTRUCTION.split("plannotator_inbox ").join(""));
    expect(content).toContain("Yes, ship it.");

    // Qwen's receipt: queued for its next turn, not yet delivered; the session is live and nothing is uncertain.
    await until(async () => (await asker(w.server, sent.thread_id)).live);
    expect(await asker(w.server, sent.thread_id)).toMatchObject({ live: true });
    expect(w.server.qwenWake.uncertain(SESSION, replyId)).toBe(false);
    expect((await thread(w.server, sent.thread_id)).messages.at(-1)!.delivery ?? null).toBeNull();

    // A restart: the claim is on disk, so it is not sent again.
    w.server.stop();
    const again = await w.start();
    await again.qwenWake.sweep();
    expect(w.session.received).toHaveLength(1);

    // The woken turn answers: that tool call records the delivery.
    const client = await connect(again);
    await client.callTool({ name: "send_message", arguments: { body: "Shipping.", reply_to: sent.message_id, agent_session: SESSION, agent_host: "qwen" } });
    await until(async () => !!(await thread(again, sent.thread_id)).messages.find((m) => m.id === replyId)?.delivery);
    expect((await thread(again, sent.thread_id)).messages.find((m) => m.id === replyId)!.delivery).toMatchObject({ state: "delivered", host: "qwen", session: SESSION });
    await again.qwenWake.sweep();
    expect(claims(w)).toEqual([]);
    expect(w.session.received).toHaveLength(1);
  });

  test("with no trusted-sender token nothing wakes: the agent is told to wait, and nothing is sent", async () => {
    const w = await world({ trust: false });
    const sent = await qwenSends(w.client, w.project, "Ship it?");
    expect(sent.text).toContain(INBOX_REPLY_WAITS_TEXT);
    await reply(w.server, sent.message_id, "Yes.");
    await w.server.qwenWake.sweep();
    await Bun.sleep(100);
    expect(w.session.received).toEqual([]);
    expect(claims(w)).toEqual([]);
  });

  test("a session driven over ACP (a shared record), a headless run, or a daemon's call is not woken", async () => {
    const w = await world();
    w.session.unregister();
    w.session.register({ file: `${process.pid}-0a1b2c3d.json` });
    expect((await qwenSends(w.client, w.project, "A?")).text).toContain(INBOX_REPLY_WAITS_TEXT);
    w.session.unregister();
    w.session.register({ kind: "headless" });
    await w.server.qwenWake.sweep(); // reads the registry and settings again
    expect((await qwenSends(w.client, w.project, "B?")).text).toContain(INBOX_REPLY_WAITS_TEXT);
    w.session.unregister();
    w.session.register();
    await w.server.qwenWake.sweep(); // reads the registry and settings again
    expect((await qwenSends(w.client, w.project, "C?", SESSION, { "qwen-code/invocation": { version: 1, sessionId: SESSION, promptId: "p1" } })).text).toContain(INBOX_REPLY_WAITS_TEXT);
    expect((await qwenSends(w.client, w.project, "D?")).text).toContain(INBOX_REPLY_ARRIVES_TEXT);
  });

  test("Qwen settings that hold or refuse other programs' messages (system, the person's, the project's; a value Qwen does not know) turn the wake off", async () => {
    const system = join(realpathSync(mkdtempSync(join(tmpdir(), "plannotator-qwen-system-"))), "settings.json");
    const w = await world({ env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: system } });
    try {
      // An administrator's system settings hold them: so does every session.
      writeFileSync(system, JSON.stringify({ agents: { crossSessionInbound: "hold" } }));
      expect((await qwenSends(w.client, w.project, "S?")).text).toContain(INBOX_REPLY_WAITS_TEXT);
      // A value this Qwen does not know is held too (Qwen fails closed).
      writeFileSync(system, JSON.stringify({ agents: { crossSessionInbound: "review-later" } }));
      await w.server.qwenWake.sweep(); // reads the registry and settings again
      expect((await qwenSends(w.client, w.project, "U?")).text).toContain(INBOX_REPLY_WAITS_TEXT);
    } finally {
      rmSync(join(system, ".."), { recursive: true, force: true });
    }
    await w.server.qwenWake.sweep();
    writeFileSync(join(w.qwenHome, "settings.json"), '{\n  // mine\n  "agents": { "crossSessionInbound": "hold" }\n}\n');
    expect((await qwenSends(w.client, w.project, "A?")).text).toContain(INBOX_REPLY_WAITS_TEXT);
    writeFileSync(join(w.qwenHome, "settings.json"), "{}");
    mkdirSync(join(w.project, ".qwen"), { recursive: true });
    writeFileSync(join(w.project, ".qwen", "settings.json"), JSON.stringify({ agents: { crossSessionMessaging: false } }));
    await w.server.qwenWake.sweep(); // reads the registry and settings again
    expect((await qwenSends(w.client, w.project, "B?")).text).toContain(INBOX_REPLY_WAITS_TEXT);
    rmSync(join(w.project, ".qwen"), { recursive: true });
    await w.server.qwenWake.sweep(); // reads the registry and settings again
    expect((await qwenSends(w.client, w.project, "C?")).text).toContain(INBOX_REPLY_ARRIVES_TEXT);
  });

  test("misaddressed (the socket serves another session now, after /clear): the session has ended, the reply is saved, and it is never sent again", async () => {
    const w = await world();
    const sent = await qwenSends(w.client, w.project, "Ship it?");
    const replyId = await reply(w.server, sent.message_id, "Yes.");
    // The record still names the session, but the process behind the socket moved on (/clear swapped its id).
    w.session.answer = "misaddressed";
    await w.server.qwenWake.sweep();
    await until(() => w.session.received.length > 0);
    await until(async () => (await asker(w.server, sent.thread_id)).live === false);
    expect((await asker(w.server, sent.thread_id)).live).toBe(false);
    expect(w.server.qwenWake.status(SESSION)).toBe("dead");
    await w.server.qwenWake.sweep();
    expect(w.session.received).toHaveLength(1);
    expect((await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)!.delivery ?? null).toBeNull();
  });

  test("a session whose process is gone has ended: nothing is sent; when its record comes back (qwen --resume) the reply goes in", async () => {
    const w = await world({ knobs: { comebackMs: 300 } });
    const sent = await qwenSends(w.client, w.project, "Ship it?");
    // The session exits: its process is gone and only a stale record is left behind.
    const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"]);
    await exited.exited;
    w.session.unregister();
    w.session.register({ pid: exited.pid });
    await w.server.qwenWake.sweep(); // reads the registry and settings again
    await reply(w.server, sent.message_id, "Yes.");
    await w.server.qwenWake.sweep();
    await Bun.sleep(150);
    expect(w.session.received).toEqual([]);
    expect(w.server.qwenWake.status(SESSION)).toBe("dead");
    expect((await asker(w.server, sent.thread_id)).live).toBe(false);

    // Resumed: a live record names the session again, and the slow look finds it.
    w.session.unregister();
    w.session.register();
    await until(() => w.session.received.length > 0, 5_000);
    expect(w.session.received).toHaveLength(1);
    expect(w.session.received[0]!.frame.toSessionId).toBe(SESSION);
  });

  test("held for the person's review in Qwen, or no receipt at all (a token Qwen dropped): saved for its next read, never sent again", async () => {
    const w = await world();
    const sent = await qwenSends(w.client, w.project, "Ship it?");
    w.session.answer = "held";
    const held = await reply(w.server, sent.message_id, "Yes.");
    await w.server.qwenWake.sweep();
    await until(() => w.server.qwenWake.uncertain(SESSION, held));
    expect(w.server.qwenWake.uncertain(SESSION, held)).toBe(true);
    expect((await asker(w.server, sent.thread_id)).connection?.uncertain).toEqual([held]);
    // Released in /peers later: queued after all.
    await w.session.receipt(w.session.received[0]!.frame, "delivered");
    await until(() => !w.server.qwenWake.uncertain(SESSION, held));
    expect(w.server.qwenWake.uncertain(SESSION, held)).toBe(false);

    const second = await qwenSends(w.client, w.project, "And the docs?");
    w.session.answer = null;
    const silent = await reply(w.server, second.message_id, "Later.");
    await w.server.qwenWake.sweep();
    await until(() => w.server.qwenWake.uncertain(SESSION, silent), 3_000);
    expect(w.server.qwenWake.uncertain(SESSION, silent)).toBe(true);
    // A restart reads both back; the silent one stays saved, and nothing is sent again.
    w.server.stop();
    const again = await w.start();
    await again.qwenWake.sweep();
    expect(again.qwenWake.uncertain(SESSION, silent)).toBe(true);
    expect(w.session.received).toHaveLength(2);
  });

  test("refused: saved, and that session is not woken again", async () => {
    const w = await world();
    const sent = await qwenSends(w.client, w.project, "Ship it?");
    w.session.answer = "refused";
    const replyId = await reply(w.server, sent.message_id, "Yes.");
    await w.server.qwenWake.sweep();
    await until(() => w.server.qwenWake.uncertain(SESSION, replyId));
    expect(w.server.qwenWake.uncertain(SESSION, replyId)).toBe(true);
    expect((await qwenSends(w.client, w.project, "Again?")).text).toContain(INBOX_REPLY_WAITS_TEXT);
  });

  test("dropped by Qwen's rate limit: sent again later with a new id", async () => {
    let clock = Date.now();
    const w = await world({ knobs: { now: () => clock } });
    const sent = await qwenSends(w.client, w.project, "Ship it?");
    w.session.answer = "dropped";
    await reply(w.server, sent.message_id, "Yes.");
    await w.server.qwenWake.sweep();
    await until(() => w.session.received.length > 0);
    await Bun.sleep(150);
    await w.server.qwenWake.sweep();
    expect(w.session.received).toHaveLength(1);
    w.session.answer = "delivered";
    clock += 31_000;
    await w.server.qwenWake.sweep();
    await until(() => w.session.received.length > 1);
    expect(w.session.received).toHaveLength(2);
    expect(w.session.received[1]!.frame.msgId).not.toBe(w.session.received[0]!.frame.msgId);
  });

  test("Qwen Code turned off while Qwen will not revoke the grant: the running Inbox stops waking at once, and agents are told to wait", async () => {
    const w = await world();
    expect((await qwenSends(w.client, w.project, "Ship it?")).text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    const refusing = createAgentEnvironmentFor({ platform: process.platform, homeDir: w.fake.home, env: { ...w.fake.env, FAKE_QWEN_CONTROLLERS_FAIL: "1" } });
    expect(await setQwenTrust(false, w.dataDir, refusing)).toContain("tries again at the next start");
    await until(() => !w.server.qwenWake.canWake());
    expect((await qwenSends(w.client, w.project, "Again?")).text).toContain(INBOX_REPLY_WAITS_TEXT);
  });

  test("Qwen stops confirming because the grant was revoked in Qwen: the token is dropped, and later agents are told to wait", async () => {
    const w = await world();
    const sent = await qwenSends(w.client, w.project, "Ship it?");
    expect(sent.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    // The person runs `qwen sessions controllers remove <id>`: Qwen now drops Plannotator's frames without a word.
    writeFileSync(join(w.qwenHome, "peer-controllers.json"), JSON.stringify({ schemaVersion: 1, controllers: [] }));
    const replyId = await reply(w.server, sent.message_id, "Yes.");
    await w.server.qwenWake.sweep();
    await until(() => w.server.qwenWake.uncertain(SESSION, replyId), 3_000);
    expect(w.server.qwenWake.uncertain(SESSION, replyId)).toBe(true);
    await until(() => qwenWakeToken(w.dataDir, w.qwenHome) === null, 5_000);
    expect(readQwenTrust(w.dataDir)).toMatchObject({ revoked_outside_at: expect.any(String) });
    await until(() => !w.server.qwenWake.canWake());
    expect((await qwenSends(w.client, w.project, "Again?")).text).toContain(INBOX_REPLY_WAITS_TEXT);
  });

  test("a malformed receipt (a token of the right length in characters, not in bytes; a line that is not JSON) ends only its own connection", async () => {
    const w = await world();
    const sent = await qwenSends(w.client, w.project, "Ship it?");
    w.session.answer = null;
    const replyId = await reply(w.server, sent.message_id, "Yes.");
    await w.server.qwenWake.sweep();
    await until(() => w.session.received.length > 0);
    const frame = w.session.received[0]!.frame;
    await sendReceipt({ ...frame, replyToken: "é".repeat(64) }, "delivered");
    await new Promise<void>((done) => {
      const socket = createConnection({ path: frame.from as string });
      socket.on("connect", () => socket.end("not json\n\u0000\n"));
      socket.on("close", () => done());
      socket.on("error", () => done());
    });
    // The Inbox still answers, and still believes the right token.
    expect((await fetch(`${base(w.server)}/api/inbox/threads/${sent.thread_id}`)).status).toBe(200);
    await w.session.receipt(frame, "delivered");
    await until(() => !w.server.qwenWake.uncertain(SESSION, replyId) && (w.server.qwenWake.uncertainItems(SESSION).length === 0));
    expect((await qwenSends(w.client, w.project, "Again?")).text).toContain(INBOX_REPLY_ARRIVES_TEXT);
  });

  test("a receipts folder a crashed Inbox left is cleared; a running one's is kept", async () => {
    // Short enough for a socket path under it (else the wake uses /tmp, and clears there).
    const parent = realpathSync(mkdtempSync(join("/tmp", "pq-")));
    try {
      const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"]);
      await exited.exited;
      const left = join(parent, `plannotator-qwen-${exited.pid}-abc123`);
      const running = join(parent, `plannotator-qwen-${process.pid}-def456`);
      mkdirSync(left);
      mkdirSync(running);
      const w = await world({ knobs: { socketParent: parent } });
      const sent = await qwenSends(w.client, w.project, "Ship it?");
      await reply(w.server, sent.message_id, "Yes.");
      await w.server.qwenWake.sweep();
      await until(() => w.session.received.length > 0);
      expect(existsSync(left)).toBe(false);
      expect(existsSync(running)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a receipt is believed only with the reply token its frame carried", async () => {
    const w = await world();
    const sent = await qwenSends(w.client, w.project, "Ship it?");
    w.session.answer = null;
    const replyId = await reply(w.server, sent.message_id, "Yes.");
    await w.server.qwenWake.sweep();
    await until(() => w.session.received.length > 0);
    const frame = w.session.received[0]!.frame;
    await sendReceipt({ ...frame, replyToken: "f".repeat(64) }, "refused");
    await Bun.sleep(150);
    // The forged refusal changed nothing: the session is still woken.
    expect((await qwenSends(w.client, w.project, "Again?")).text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    void replyId;
  });
});

describe("Qwen's settings, merged as Qwen merges them", () => {
  const file = (agents: { messaging?: unknown; inbound?: unknown }): QwenAgentsSettings => ({ kind: "file", messaging: agents.messaging, inbound: agents.inbound });
  const none: QwenAgentsSettings = { kind: "missing" };
  const keptOut = (scopes: Partial<Record<"systemDefaults" | "user" | "workspace" | "system", QwenAgentsSettings>>) =>
    qwenSettingsKeepOut({ systemDefaults: none, user: none, workspace: none, system: none, ...scopes });

  test("unset lets a trusted sender in; hold, refuse, an unknown value, messaging off, or a file Qwen cannot read keep it out", () => {
    expect(keptOut({})).toBe(false);
    expect(keptOut({ user: file({ inbound: "accept" }) })).toBe(false);
    for (const inbound of ["hold", "refuse", "later"]) expect(keptOut({ user: file({ inbound }) })).toBe(true);
    expect(keptOut({ user: file({ messaging: false }) })).toBe(true);
    expect(keptOut({ user: file({ messaging: "no" }) })).toBe(true);
    expect(keptOut({ user: { kind: "unreadable" } })).toBe(true);
  });

  test("system settings win over the person's; a project can only tighten; system defaults give way to the person's", () => {
    expect(keptOut({ user: file({ inbound: "hold" }), system: file({ inbound: "accept" }) })).toBe(false);
    expect(keptOut({ user: file({ inbound: "accept" }), system: file({ inbound: "refuse" }) })).toBe(true);
    expect(keptOut({ user: file({ inbound: "hold" }), workspace: file({ inbound: "accept" }) })).toBe(true);
    expect(keptOut({ workspace: file({ inbound: "hold" }) })).toBe(true);
    expect(keptOut({ systemDefaults: file({ inbound: "hold" }), user: file({ inbound: "accept" }) })).toBe(false);
  });
});

describe("a registry record", () => {
  test("is live only while its process runs (and, on Linux, the same boot and start)", async () => {
    const exited = Bun.spawn(["/bin/sh", "-c", "exit 0"]);
    await exited.exited;
    const record = { pid: process.pid, sessionId: SESSION, kind: "tui", ipcPath: "/tmp/x.sock", ipcToken: null, cwd: null, startedAt: 1, shared: false, ...identity(process.pid) };
    expect(qwenRecordLive(record)).toBe(true);
    expect(qwenRecordLive({ ...record, pid: exited.pid })).toBe(false);
    // Written on another machine sharing this home (a boot id that is not ours).
    expect(qwenRecordLive({ ...record, procStart: "another-boot:123" })).toBe(false);
  });
});
