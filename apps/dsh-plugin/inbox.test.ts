/**
 * @plannotator/dsh's Inbox connection against a fake DeepSeek Harness host
 * and a scratch Inbox (in this process, its own temp data dir, loopback).
 *
 * The fake host implements only what the plugin uses: `ctx.agents` (get,
 * list), agents with `status`, `inbox`, `followup` and `steer`, `ctx.tools`
 * (`register`), the agent events, and `ctx.get` for services. DSH is never
 * installed or run. The agent writes through the plugin's own
 * `plannotator_inbox` tool; the person replies through the window's routes.
 *
 * Run: bun test apps/dsh-plugin/inbox.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "../../packages/server/inbox";
import type { InboxThread } from "../../packages/core/inbox-types";
import { inboxLeaseFileOf } from "../../packages/shared/inbox/agent-link";
import {
  DSH_INBOX_HOST,
  setupDshInbox,
  type DshInbox,
  type DshInboxAgent,
  type DshInboxContext,
  type DshToolDefinition,
} from "./inbox";
import type { DshUserMessage } from "./plan-review";

const roots: string[] = [];
const servers: InboxServer[] = [];
const inboxes: DshInbox[] = [];

afterEach(() => {
  for (const inbox of inboxes.splice(0)) inbox.dispose();
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TICK = 40;
const ON = { PLANNOTATOR_INBOX_TOOL: "1" } as NodeJS.ProcessEnv;

/** One fake DSH agent: what the plugin reads and the two ways a turn goes in. */
class FakeAgent implements DshInboxAgent {
  status: "idle" | "running" = "idle";
  readonly inbox = { nextTurn: [] as unknown[], nextStep: [] as unknown[] };
  readonly followups: DshUserMessage[] = [];
  readonly steers: DshUserMessage[] = [];
  readonly session: { header: { cwd: string; parentSession?: string; origin?: string; delegationDepth?: number } };
  /** Set to drop a method, as an older or trimmed DSH would. */
  followup?: (message: DshUserMessage) => void = (message) => {
    this.followups.push(message);
    this.host.emit("agent/inbox/inserted", { agent: this, message });
  };
  steer?: (message: DshUserMessage) => void = (message) => {
    this.steers.push(message);
    this.host.emit("agent/inbox/inserted", { agent: this, message });
  };

  constructor(
    readonly id: string,
    cwd: string,
    private readonly host: FakeDsh,
    header: { parentSession?: string; origin?: string; delegationDepth?: number } = {},
  ) {
    this.session = { header: { cwd, ...header } };
  }

  texts(): string[] {
    return this.followups.map((m) => m.content[0]!.text);
  }
}

/** The fake DSH process: its agents, services and event bus. */
class FakeDsh {
  readonly agents = new Map<string, FakeAgent>();
  readonly listeners = new Map<string, ((payload: any) => unknown)[]>();
  readonly tools: DshToolDefinition[] = [];
  readonly warnings: string[] = [];
  readonly services: Record<string, unknown>;

  constructor(options: { profile?: string; noAgents?: boolean; noTools?: boolean } = {}) {
    this.services = {
      ...(options.noAgents ? {} : { agents: { get: (id: string) => this.agents.get(id), list: () => [...this.agents.values()] } }),
      ...(options.noTools ? {} : { tools: { register: (definition: DshToolDefinition) => void this.tools.push(definition) } }),
      profileContext: { name: options.profile ?? "web" },
    };
  }

  readonly ctx: DshInboxContext = {
    on: (event, listener) => {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return () => true;
    },
    get: (name) => this.services[name],
    logger: { warn: (format: string, ...args: unknown[]) => void this.warnings.push([format, ...args].join(" ")), info: () => {} },
  };

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  /** A new session, as DSH creates one: in the registry, then `agent/created`. */
  create(id: string, cwd: string, header: { parentSession?: string; origin?: string; delegationDepth?: number } = {}): FakeAgent {
    const agent = new FakeAgent(id, cwd, this, header);
    this.agents.set(id, agent);
    this.emit("agent/created", { agent, source: "startup" });
    return agent;
  }

  dispose(agent: FakeAgent): void {
    this.agents.delete(agent.id);
    this.emit("agent/disposed", { agent });
  }

  /** The model calls `plannotator_inbox` in `agent`'s session. */
  async call(agent: FakeAgent, args: Record<string, unknown>): Promise<{ text: string }> {
    const tool = this.tools.find((t) => t.name === "plannotator_inbox");
    if (!tool) throw new Error("plannotator_inbox is not registered");
    return (await tool.execute(args, { agent })) as { text: string };
  }
}

async function world(options: { profile?: string; noAgents?: boolean; noTools?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-dsh-inbox-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const dsh = new FakeDsh(options);
  return { root, project, dataDir, server, dsh };
}

async function start(w: Awaited<ReturnType<typeof world>>, deps: Parameters<typeof setupDshInbox>[1] = {}): Promise<DshInbox | null> {
  const inbox = await setupDshInbox(w.dsh.ctx, { env: ON, dataDir: w.dataDir, tickMs: TICK, version: "9.9.9", ...deps });
  if (inbox) inboxes.push(inbox);
  return inbox;
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function reply(server: InboxServer, messageId: string, words: string): Promise<{ id: string }> {
  const response = await fetch(`${base(server)}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k-${messageId}-${words}`, words }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { reply: { id: string } }).reply;
}

async function sendNow(server: InboxServer, messageId: string): Promise<number> {
  const response = await fetch(`${base(server)}/api/inbox/messages/${messageId}/send-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession }),
  });
  return response.status;
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

/** Whether the window would offer Send now into `session` (its live connection's `send_now`). */
async function sendNowOffered(server: InboxServer, threadId: string, session: string): Promise<boolean | null> {
  const response = await fetch(`${base(server)}/api/inbox/threads/${threadId}/sessions?asker=${session}`);
  const body = (await response.json()) as { asker?: { connection?: { send_now?: boolean } | null } };
  return body.asker?.connection?.send_now ?? null;
}

/** The message ids the agent's send result names. */
function idsOf(text: string): { message_id: string; thread_id: string } {
  const message_id = /"message_id":"([^"]+)"/.exec(text)?.[1];
  const thread_id = /"thread_id":"([^"]+)"/.exec(text)?.[1];
  if (!message_id || !thread_id) throw new Error(`no ids in the send result: ${text}`);
  return { message_id, thread_id };
}

async function until(check: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (await check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

async function deliveryOf(server: InboxServer, threadId: string, id: string) {
  let found: unknown = null;
  await until(async () => {
    found = (await thread(server, threadId)).messages.find((m) => m.id === id)?.delivery ?? null;
    return found !== null;
  });
  return found as { host: string; session: string } | null;
}

describe("DeepSeek Harness: the Inbox wake (fake DSH host)", () => {
  test("a reply wakes an idle session as a followup turn, once, and the thread says Delivered to DeepSeek Harness", async () => {
    const w = await world();
    const agent = w.dsh.create("session-a", w.project);
    expect(await start(w)).not.toBeNull();
    // One native tool, the shared contract's, registered with DSH's required output declaration.
    expect(w.dsh.tools.map((t) => t.name)).toEqual(["plannotator_inbox"]);
    expect(w.dsh.tools[0]!.output.render({}, { text: "hi" })).toEqual([{ type: "text", text: "hi" }]);
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Drafted the release notes. Ship today?" })).text);
    const message = (await thread(w.server, sent.thread_id)).messages[0]!;
    // Signed as the session, by the host the plugin names, and recorded as a waking send.
    expect(message.author).toMatchObject({ kind: "agent", host: DSH_INBOX_HOST, session: "session-a", name: "DeepSeek Harness" });
    expect(message.wakes).toBe(true);
    const answer = await reply(w.server, sent.message_id, "Yes, ship it.");
    expect(await until(() => agent.followups.length > 0)).toBe(true);
    expect(agent.texts()[0]).toStartWith("Plannotator Inbox: ");
    expect(agent.texts()[0]).toContain(`(${answer.id})`);
    expect(agent.texts()[0]).toContain("Yes, ship it.");
    // A user-role message DSH can persist, as dsh-llm's createUserMessage makes one.
    expect(agent.followups[0]).toMatchObject({ role: "user", source: { kind: "user" }, content: [{ type: "text" }] });
    expect(agent.steers).toEqual([]);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-a" });
    await Bun.sleep(TICK * 8);
    expect(agent.followups).toHaveLength(1);
  });

  test("a running session is never interrupted: the reply waits for idle, then goes in as a turn", async () => {
    const w = await world();
    const agent = w.dsh.create("session-run", w.project);
    await start(w);
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Which port?" })).text);
    agent.status = "running";
    await reply(w.server, sent.message_id, "Use 8080.");
    await Bun.sleep(TICK * 10);
    expect(agent.followups).toEqual([]);
    expect(agent.steers).toEqual([]);
    // Idle, but a prompt still queued in its inbox: still not.
    agent.status = "idle";
    agent.inbox.nextTurn.push({});
    await Bun.sleep(TICK * 8);
    expect(agent.followups).toEqual([]);
    agent.inbox.nextTurn.length = 0;
    expect(await until(() => agent.followups.length === 1)).toBe(true);
  });

  test("Send now while a turn runs steers it into that turn, once, and it is acknowledged", async () => {
    const w = await world();
    const agent = w.dsh.create("session-steer", w.project);
    await start(w);
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Retry the deploy?" })).text);
    expect(await until(() => sendNowOffered(w.server, sent.thread_id, "session-steer"))).toBe(true);
    agent.status = "running";
    const answer = await reply(w.server, sent.message_id, "Retry once.");
    await Bun.sleep(TICK * 6);
    expect(agent.steers).toEqual([]);
    expect(await sendNow(w.server, answer.id)).toBe(200);
    expect(await until(() => agent.steers.length > 0)).toBe(true);
    expect(agent.steers[0]!.content[0]!.text).toContain("Retry once.");
    expect(agent.followups).toEqual([]);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-steer" });
    agent.status = "idle";
    await Bun.sleep(TICK * 8);
    expect(agent.steers).toHaveLength(1);
    expect(agent.followups).toEqual([]);
  });

  test("two sessions in one DSH process never get each other's replies", async () => {
    const w = await world();
    const a = w.dsh.create("session-one", w.project);
    const b = w.dsh.create("session-two", w.project);
    await start(w);
    const toA = idsOf((await w.dsh.call(a, { action: "send_message", body: "A asks.", thread: "lane a" })).text);
    const toB = idsOf((await w.dsh.call(b, { action: "send_message", body: "B asks.", thread: "lane b" })).text);
    const forA = await reply(w.server, toA.message_id, "Answer for A.");
    expect(await until(() => a.followups.length === 1)).toBe(true);
    await Bun.sleep(TICK * 6);
    expect(b.followups).toEqual([]);
    const forB = await reply(w.server, toB.message_id, "Answer for B.");
    expect(await until(() => b.followups.length === 1)).toBe(true);
    await Bun.sleep(TICK * 6);
    expect(a.texts()).toHaveLength(1);
    expect(a.texts()[0]).toContain(forA.id);
    expect(a.texts()[0]).not.toContain("Answer for B.");
    expect(b.texts()[0]).toContain(forB.id);
    expect(b.texts()[0]).not.toContain("Answer for A.");
  });

  test("a session created after load gets its wake; a disposed one stops polling", async () => {
    const w = await world();
    const inbox = (await start(w))!;
    expect(inbox.wakes.size).toBe(0);
    const agent = w.dsh.create("session-late", w.project);
    expect([...inbox.wakes.keys()]).toEqual(["session-late"]);
    w.dsh.dispose(agent);
    expect(inbox.wakes.size).toBe(0);
  });

  test("a subagent's call is signed by, and woken in, the session it works for", async () => {
    const w = await world();
    const parent = w.dsh.create("session-parent", w.project);
    const child = w.dsh.create("session-child", w.project, { parentSession: "session-parent", origin: "subagent", delegationDepth: 1 });
    const inbox = (await start(w))!;
    expect([...inbox.wakes.keys()]).toEqual(["session-parent"]);
    const sent = idsOf((await w.dsh.call(child, { action: "send_message", body: "From a subagent." })).text);
    expect((await thread(w.server, sent.thread_id)).messages[0]!.author).toMatchObject({ host: "dsh", session: "session-parent" });
    await reply(w.server, sent.message_id, "Seen.");
    expect(await until(() => parent.followups.length === 1)).toBe(true);
    expect(child.followups).toEqual([]);
  });

  // Web and Desktop on one session share it through the lease: the process the person last typed in takes the replies.
  test("the person's typing claims the session for this process; the reply the wake put in does not", async () => {
    const w = await world();
    const agent = w.dsh.create("session-lease", w.project);
    await start(w);
    const touchedAt = () => (JSON.parse(readFileSync(inboxLeaseFileOf(w.dataDir, "dsh", "session-lease"), "utf8")) as { touchedAt: number }).touchedAt;
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Lease?" })).text);
    await Bun.sleep(20);
    const beforeDelivery = touchedAt();
    expect(beforeDelivery).toBeGreaterThan(0);
    await reply(w.server, sent.message_id, "Fine.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    await Bun.sleep(20);
    expect(touchedAt()).toBe(beforeDelivery);
    // Something that is not the person (a system note) does not claim it either.
    w.dsh.emit("agent/inbox/inserted", { agent, message: { id: "note-1", source: { kind: "system" } } });
    expect(touchedAt()).toBe(beforeDelivery);
    w.dsh.emit("agent/inbox/inserted", { agent, message: { id: "typed-1", source: { kind: "user" } } });
    expect(touchedAt()).toBeGreaterThan(beforeDelivery);
  });
});

describe("DeepSeek Harness: what turns it off, and a DSH without a service", () => {
  test("off by default: without the switch nothing is registered and nothing polls", async () => {
    const w = await world();
    w.dsh.create("session-off", w.project);
    expect(await start(w, { env: {} as NodeJS.ProcessEnv })).toBeNull();
    expect(await start(w, { env: { PLANNOTATOR_INBOX_TOOL: "0" } as NodeJS.ProcessEnv })).toBeNull();
    expect(w.dsh.tools).toEqual([]);
    expect(w.dsh.listeners.size).toBe(0);
  });

  test("no Inbox ever ran here (no registry): nothing starts", async () => {
    const w = await world();
    expect(await start(w, { dataDir: join(w.root, "never-ran") })).toBeNull();
    expect(w.dsh.tools).toEqual([]);
  });

  for (const profile of ["headless", "sdk", "sdk-minimal", "acp"]) {
    test(`the ${profile} profile takes no turns of ours: nothing starts`, async () => {
      const w = await world({ profile });
      w.dsh.create("session-p", w.project);
      expect(await start(w)).toBeNull();
      expect(w.dsh.listeners.size).toBe(0);
    });
  }

  test("no agents service: it says so once and starts nothing, without throwing", async () => {
    const w = await world({ noAgents: true });
    expect(await start(w)).toBeNull();
    expect(w.dsh.tools).toEqual([]);
    expect(w.dsh.warnings.some((line) => line.includes("no agents service"))).toBe(true);
  });

  test("a ctx.get that throws reads as no service", async () => {
    const w = await world();
    w.dsh.ctx.get = () => {
      throw new Error("not ready");
    };
    expect(await start(w)).toBeNull();
  });

  test("no tools service: replies still wake the session, and it says the tool is missing", async () => {
    const w = await world({ noTools: true });
    const agent = w.dsh.create("session-notools", w.project);
    const inbox = (await start(w))!;
    expect(inbox).not.toBeNull();
    expect(w.dsh.tools).toEqual([]);
    expect(w.dsh.warnings.some((line) => line.includes("no tools service"))).toBe(true);
    // The session wrote some other way (a DSH shell's `plannotator inbox call`), as a waking send.
    const result = await inbox.connection.callTool({ action: "send_message", body: "From a script." }, { sessionId: "session-notools", cwd: w.project, wakes: true });
    const ids = idsOf(result.text);
    await reply(w.server, ids.message_id, "Got it.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
  });

  test("an agent without followup: the reply is not lost or retried forever; the person is told, and nothing throws", async () => {
    const w = await world();
    const agent = w.dsh.create("session-nofollowup", w.project);
    agent.followup = undefined;
    await start(w);
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Hello?" })).text);
    await reply(w.server, sent.message_id, "Hi.");
    expect(await until(() => w.dsh.warnings.some((line) => line.includes("could not be delivered")))).toBe(true);
    expect(w.dsh.warnings.find((line) => line.includes("could not be delivered"))).toContain("no agent.followup");
  });

  test("an agent without steer: Send now is not offered into its turn, and the reply waits for idle", async () => {
    const w = await world();
    const agent = w.dsh.create("session-nosteer", w.project);
    agent.steer = undefined;
    await start(w);
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Go?" })).text);
    // The window is told Send now cannot go into this session's turn, so it does not offer it.
    expect(await until(async () => (await sendNowOffered(w.server, sent.thread_id, "session-nosteer")) === false)).toBe(true);
    agent.status = "running";
    const answer = await reply(w.server, sent.message_id, "Go.");
    await sendNow(w.server, answer.id);
    await Bun.sleep(TICK * 10);
    expect(agent.followups).toEqual([]);
    agent.status = "idle";
    expect(await until(() => agent.followups.length === 1)).toBe(true);
  });

  test("a session that is gone from DSH reads as busy: nothing is sent into nowhere", async () => {
    const w = await world();
    const agent = w.dsh.create("session-gone", w.project);
    const inbox = (await start(w))!;
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Still there?" })).text);
    // Removed from the registry without `agent/disposed` (a DSH that never says): the wake stays, and holds the reply.
    w.dsh.agents.delete(agent.id);
    await reply(w.server, sent.message_id, "Yes.");
    await Bun.sleep(TICK * 10);
    expect(agent.followups).toEqual([]);
    expect(inbox.wakes.has("session-gone")).toBe(true);
    // Not tried and given up on: when the session is back (resumed), the reply goes in, once, with nothing reported lost.
    w.dsh.agents.set(agent.id, agent);
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    expect(w.dsh.warnings).toEqual([]);
  });

  test("unload stops every wake, and a setup still discovering when the plugin unloads starts nothing", async () => {
    const w = await world();
    w.dsh.create("session-u", w.project);
    const inbox = (await start(w))!;
    const wake = inbox.wakes.get("session-u")!;
    inbox.dispose();
    expect(wake.isDisposed).toBe(true);
    const unload = new AbortController();
    const pending = setupDshInbox(w.dsh.ctx, {
      env: ON,
      dataDir: w.dataDir,
      discover: async () => {
        unload.abort();
        return [];
      },
      unloadSignal: unload.signal,
    });
    expect(await pending).toBeNull();
  });
});

/** Every string reachable from `root` (objects, arrays, Maps, Sets), private fields included. */
function stringsIn(root: unknown): string[] {
  const seen = new Set<unknown>();
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") return void out.push(value);
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) for (const [k, v] of value) (walk(k), walk(v));
    else if (value instanceof Set) for (const v of value) walk(v);
    else for (const key of Object.getOwnPropertyNames(value)) walk((value as Record<string, unknown>)[key]);
  };
  walk(root);
  return out;
}

// DSH runs plugins in its own process (SECURITY-REVIEW finding 3): what the plugin holds, logs,
// returns or sends into a session is readable by DSH and its other plugins, and session events go to DeepSeek.
describe("DeepSeek Harness: the Inbox key stays out of DSH's reach", () => {
  test("through a send, a read, a reply wake and a failed delivery, the key is in no message, result, log line, tool definition or plugin state", async () => {
    const w = await world();
    const token = (JSON.parse(readFileSync(join(w.dataDir, "inbox", "inbox.json"), "utf8")) as { token: string }).token;
    expect(token.length).toBeGreaterThan(8);
    const agent = w.dsh.create("session-key", w.project);
    const deaf = w.dsh.create("session-deaf", w.project);
    deaf.followup = undefined;
    const inbox = (await start(w))!;
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Ready?" })).text);
    const read = await w.dsh.call(agent, { action: "read_thread", thread_id: sent.thread_id });
    const deafSent = idsOf((await w.dsh.call(deaf, { action: "send_message", body: "There?" })).text);
    await reply(w.server, sent.message_id, "Ready.");
    await reply(w.server, deafSent.message_id, "Here.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    expect(await until(() => w.dsh.warnings.some((line) => line.includes("could not be delivered")))).toBe(true);
    const reachable = stringsIn({ inbox, tools: w.dsh.tools, warnings: w.dsh.warnings, followups: agent.followups, steers: agent.steers, read, sent });
    expect(reachable.length).toBeGreaterThan(0);
    expect(reachable.filter((text) => text.includes(token))).toEqual([]);
  });
});
