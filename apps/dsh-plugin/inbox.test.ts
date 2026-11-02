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
  DSH_ROOT_FOR_ENV,
  DSH_ROOT_SESSION_ENV,
  setupDshInbox,
  type DshInbox,
  type DshInboxAgent,
  type DshInboxContext,
  type DshToolDefinition,
} from "./inbox";
import type { DshUserMessage } from "./plan-review";
import { applyPlannotator, DSH_INBOX_SERVICES } from "./plugin";

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
  readonly session: { header: { id?: string; cwd: string; parentSession?: string; origin?: string; delegationDepth?: number } };
  /** Leave what goes in queued (a long tool call holds a steer; the turn has not started): the test claims or discards it. */
  hold = false;
  /** A DSH that emits no `agent/inbox/claimed`: the turn takes the message silently. */
  silentClaims = false;
  /** Set to drop a method, as an older or trimmed DSH would. */
  followup?: (message: DshUserMessage) => void = (message) => {
    this.followups.push(message);
    this.put("nextTurn", message);
  };
  steer?: (message: DshUserMessage) => void = (message) => {
    this.steers.push(message);
    this.put("nextStep", message);
  };

  /** As DSH's ReactLoopInbox: queued, `agent/inbox/inserted`, then a turn claims it (at once here, unless held). */
  private put(list: "nextTurn" | "nextStep", message: DshUserMessage): void {
    this.inbox[list].push(message);
    this.host.emit("agent/inbox/inserted", { agent: this, message });
    if (!this.hold) queueMicrotask(() => this.claim(message.id));
  }

  /** A turn takes the message: out of the queue, `agent/inbox/claimed`. */
  claim(id: string): void {
    const message = this.take(id);
    if (message && !this.silentClaims) this.host.emit("agent/inbox/claimed", { agent: this, message, turn: 1 });
  }

  /** The person takes it out of the queue (or cancels the turn and its queue): `agent/inbox/discarded`. */
  discard(id: string): void {
    const message = this.take(id);
    if (message) this.host.emit("agent/inbox/discarded", { agent: this, message });
  }

  /** The person edits it in the queue (DSH Web's edit, ReactLoopInbox.replace): discarded, then the same id inserted in its place. */
  edit(id: string, text: string): void {
    for (const list of [this.inbox.nextTurn, this.inbox.nextStep]) {
      const at = list.findIndex((item) => (item as { id?: unknown }).id === id);
      if (at < 0) continue;
      const old = list.splice(at, 1)[0] as DshUserMessage;
      this.host.emit("agent/inbox/discarded", { agent: this, message: old });
      const edited = { ...old, content: [{ type: "text" as const, text }] };
      list.splice(at, 0, edited);
      this.host.emit("agent/inbox/inserted", { agent: this, message: edited });
      return;
    }
  }

  /** The person steers a queued follow-up into the running turn (DSH's queue steer): removed (discarded), then `agent.steer` with it. */
  steerFromQueue(id: string): void {
    const message = this.take(id) as DshUserMessage | undefined;
    if (!message) return;
    this.host.emit("agent/inbox/discarded", { agent: this, message });
    this.steer!(message);
  }

  /** DSH's `cancel` without `keepInbox`: every queued item discarded. */
  clearQueue(): void {
    for (const list of [this.inbox.nextStep, this.inbox.nextTurn]) {
      for (const message of list.splice(0)) this.host.emit("agent/inbox/discarded", { agent: this, message });
    }
  }

  private take(id: string): unknown {
    for (const list of [this.inbox.nextTurn, this.inbox.nextStep]) {
      const at = list.findIndex((item) => (item as { id?: unknown }).id === id);
      if (at >= 0) return list.splice(at, 1)[0];
    }
    return undefined;
  }

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

  /** Services not active yet (Cordis `ctx.get` answers undefined for them until `provide`). */
  readonly late = new Set<string>();
  /** The disposers `ctx.effect` collected: run on unload. */
  readonly effects: (() => void)[] = [];
  private readonly injects: { deps: string[]; run: () => void; ran: boolean; effects: (() => void)[] }[] = [];

  readonly ctx: DshInboxContext = {
    on: (event, listener) => {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return () => true;
    },
    get: (name) => (this.late.has(name) ? undefined : this.services[name]),
    logger: { warn: (format: string, ...args: unknown[]) => void this.warnings.push([format, ...args].join(" ")), info: () => {} },
  };

  /** The same context with Cordis' `effect` and `inject`, as a real DSH hands a plugin. */
  readonly cordis: DshInboxContext = {
    ...this.ctx,
    effect: (execute: () => () => void) => void this.effects.push(execute()),
    inject: (deps, callback) => {
      // A child context: its effects are its own, disposed when a service it needs goes away (Cordis' fiber).
      const entry = { deps, ran: false, effects: [] as (() => void)[], run: () => void callback({ ...this.cordis, effect: (execute: () => () => void) => void entry.effects.push(execute()) }) };
      this.injects.push(entry);
      this.runReady();
    },
  };

  /** A late service becomes active: the injected children waiting on it run. */
  provide(name: string): void {
    this.late.delete(name);
    this.runReady();
  }

  /** A service goes away (replaced, or its plugin unloaded): the children that needed it are disposed and wait again. */
  withdraw(name: string): void {
    this.late.add(name);
    for (const entry of this.injects) {
      if (!entry.ran || !entry.deps.includes(name)) continue;
      entry.ran = false;
      for (const dispose of entry.effects.splice(0)) dispose();
    }
  }

  /** The plugin unloads: every effect's disposer runs, its children's too. */
  unload(): void {
    for (const entry of this.injects) for (const dispose of entry.effects.splice(0)) dispose();
    for (const dispose of this.effects.splice(0)) dispose();
  }

  private runReady(): void {
    for (const entry of this.injects) {
      if (entry.ran || entry.deps.some((dep) => this.late.has(dep) || this.services[dep] === undefined)) continue;
      entry.ran = true;
      entry.run();
    }
  }

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

  /**
   * The session closes, as DSH's agent teardown (agent-loop index.ts): `cancel({ kind: 'disposed' },
   * { keepInbox: !ready })` clears a ready session's queue, discarding each item, then awaits before
   * the agent leaves the registry and `agent/disposed` goes out.
   */
  async dispose(agent: FakeAgent, options: { ready?: boolean } = {}): Promise<void> {
    if (options.ready !== false) agent.clearQueue();
    await null;
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
    await w.dsh.dispose(agent);
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

/** The reply's delivery as the thread holds it now (no waiting). */
async function deliveryNow(server: InboxServer, threadId: string, id: string) {
  return (await thread(server, threadId)).messages.find((m) => m.id === id)?.delivery ?? null;
}

// Pi marks a reply delivered when its message starts; DSH says when a turn takes a queued message.
describe("DeepSeek Harness: delivered means a turn took it", () => {
  const CHECK = 60;

  test("a reply still queued in the session is not delivered yet; the turn taking it is", async () => {
    const w = await world();
    const agent = w.dsh.create("session-held", w.project);
    agent.hold = true;
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Held?" })).text);
    const answer = await reply(w.server, sent.message_id, "Take it.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    await Bun.sleep(CHECK * 4);
    expect(await deliveryNow(w.server, sent.thread_id, answer.id)).toBeNull();
    agent.claim(agent.followups[0]!.id);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-held" });
    expect(agent.followups).toHaveLength(1);
  });

  test("the turn taking it marks it delivered at once, not at the next look", async () => {
    const w = await world();
    const agent = w.dsh.create("session-claimed", w.project);
    agent.hold = true;
    await start(w, { deliveryCheckMs: 60_000 });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Now?" })).text);
    const answer = await reply(w.server, sent.message_id, "Now.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    agent.claim(agent.followups[0]!.id);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-claimed" });
  });

  test("Send now steered in, then taken out of the queue before a step read it: the reply waits for idle and goes in once as a turn", async () => {
    const w = await world();
    const agent = w.dsh.create("session-parked", w.project);
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Deploy?" })).text);
    agent.status = "running";
    agent.hold = true;
    const answer = await reply(w.server, sent.message_id, "Deploy.");
    await Bun.sleep(TICK * 6);
    expect(await sendNow(w.server, answer.id)).toBe(200);
    expect(await until(() => agent.steers.length === 1)).toBe(true);
    agent.discard(agent.steers[0]!.id);
    await Bun.sleep(CHECK * 3);
    expect(await deliveryNow(w.server, sent.thread_id, answer.id)).toBeNull();
    expect(agent.followups).toEqual([]);
    agent.hold = false;
    agent.status = "idle";
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-parked" });
    expect(agent.steers).toHaveLength(1);
  });

  test("a turn's reply taken out of the queue is never marked delivered, and is not put back", async () => {
    const w = await world();
    const agent = w.dsh.create("session-dropped", w.project);
    agent.hold = true;
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Drop?" })).text);
    const answer = await reply(w.server, sent.message_id, "Dropped.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    agent.discard(agent.followups[0]!.id);
    expect(await until(() => w.dsh.warnings.some((line) => line.includes("could not be delivered")))).toBe(true);
    expect(w.dsh.warnings.find((line) => line.includes("could not be delivered"))).toContain("taken out of the session's queue");
    await Bun.sleep(CHECK * 4);
    expect(await deliveryNow(w.server, sent.thread_id, answer.id)).toBeNull();
    expect(agent.followups).toHaveLength(1);
  });

  test("the person edits the queued Send now reply in DSH Web: it is not sent again, and the turn taking it delivers it once", async () => {
    const w = await world();
    const agent = w.dsh.create("session-edit", w.project);
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Ship?" })).text);
    agent.status = "running";
    agent.hold = true;
    const answer = await reply(w.server, sent.message_id, "Ship.");
    await Bun.sleep(TICK * 6);
    expect(await sendNow(w.server, answer.id)).toBe(200);
    expect(await until(() => agent.steers.length === 1)).toBe(true);
    agent.edit(agent.steers[0]!.id, "Ship it on Monday.");
    await Bun.sleep(CHECK * 3);
    // Still queued, as edited: neither delivered nor failed, and not given back for a second go.
    expect(await deliveryNow(w.server, sent.thread_id, answer.id)).toBeNull();
    agent.claim(agent.steers[0]!.id);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-edit" });
    agent.hold = false;
    agent.status = "idle";
    await Bun.sleep(TICK * 8);
    expect(agent.steers).toHaveLength(1);
    expect(agent.followups).toEqual([]);
    expect(w.dsh.warnings).toEqual([]);
  });

  test("the person steers the queued reply from DSH's queue into the running turn: it is delivered, once", async () => {
    const w = await world();
    const agent = w.dsh.create("session-queue-steer", w.project);
    agent.hold = true;
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Now?" })).text);
    const answer = await reply(w.server, sent.message_id, "Now, please.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    agent.status = "running";
    agent.steerFromQueue(agent.followups[0]!.id);
    await Bun.sleep(CHECK * 3);
    expect(await deliveryNow(w.server, sent.thread_id, answer.id)).toBeNull();
    agent.claim(agent.steers[0]!.id);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-queue-steer" });
    agent.status = "idle";
    agent.hold = false;
    await Bun.sleep(TICK * 8);
    expect(agent.followups).toHaveLength(1);
    expect(agent.steers).toHaveLength(1);
    expect(w.dsh.warnings).toEqual([]);
  });

  test("the session closes with the reply queued (DSH clears a ready session's queue): it is not reported lost, and goes in once when the session resumes", async () => {
    const w = await world();
    const agent = w.dsh.create("session-closing", w.project);
    agent.hold = true;
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Closing?" })).text);
    const answer = await reply(w.server, sent.message_id, "Fine.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    await w.dsh.dispose(agent);
    expect(agent.inbox.nextTurn).toEqual([]);
    await Bun.sleep(CHECK * 4);
    expect(await deliveryNow(w.server, sent.thread_id, answer.id)).toBeNull();
    expect(w.dsh.warnings).toEqual([]);
    const resumed = w.dsh.create("session-closing", w.project);
    expect(await until(() => resumed.followups.length === 1)).toBe(true);
    expect(resumed.texts()[0]).toContain("Fine.");
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-closing" });
    await Bun.sleep(TICK * 8);
    expect(resumed.followups).toHaveLength(1);
    expect(agent.followups).toHaveLength(1);
    expect(w.dsh.warnings).toEqual([]);
  });

  test("the session closes with Send now's steer queued: the reply goes in once, as a turn, when the session resumes", async () => {
    const w = await world();
    const agent = w.dsh.create("session-closing-steer", w.project);
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Stop?" })).text);
    agent.status = "running";
    agent.hold = true;
    const answer = await reply(w.server, sent.message_id, "Stop.");
    await Bun.sleep(TICK * 6);
    expect(await sendNow(w.server, answer.id)).toBe(200);
    expect(await until(() => agent.steers.length === 1)).toBe(true);
    await w.dsh.dispose(agent);
    await Bun.sleep(CHECK * 3);
    expect(await deliveryNow(w.server, sent.thread_id, answer.id)).toBeNull();
    const resumed = w.dsh.create("session-closing-steer", w.project);
    expect(await until(() => resumed.followups.length === 1)).toBe(true);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-closing-steer" });
    await Bun.sleep(TICK * 8);
    expect(resumed.followups).toHaveLength(1);
    expect(agent.followups).toEqual([]);
    expect(w.dsh.warnings).toEqual([]);
  });

  test("a session closed before it was ready keeps its queue (keepInbox): the reply waiting there counts as delivered", async () => {
    const w = await world();
    const agent = w.dsh.create("session-not-ready", w.project);
    agent.hold = true;
    await start(w, { deliveryCheckMs: 60_000 });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Early?" })).text);
    const answer = await reply(w.server, sent.message_id, "Early.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    await w.dsh.dispose(agent, { ready: false });
    expect(agent.inbox.nextTurn).toHaveLength(1);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-not-ready" });
  });

  test("DSH quits with the reply queued, the plugin unloading first: not marked delivered, and it goes in once after the next start", async () => {
    const w = await world();
    const agent = w.dsh.create("session-quit", w.project);
    agent.hold = true;
    const inbox = (await start(w, { deliveryCheckMs: CHECK }))!;
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Quitting?" })).text);
    const answer = await reply(w.server, sent.message_id, "Bye.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    // DSH's quit: the plugin unloads, then agent-loop closes the ready session and clears its queue.
    inbox.dispose();
    await w.dsh.dispose(agent);
    expect(agent.inbox.nextTurn).toEqual([]);
    await Bun.sleep(CHECK * 4);
    expect(await deliveryNow(w.server, sent.thread_id, answer.id)).toBeNull();
    expect(w.dsh.warnings).toEqual([]);
    // The next DSH start: the plugin loads, the session resumes.
    const next = { ...w, dsh: new FakeDsh() };
    const resumed = next.dsh.create("session-quit", w.project);
    await start(next, { deliveryCheckMs: CHECK });
    expect(await until(() => resumed.followups.length === 1)).toBe(true);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-quit" });
    await Bun.sleep(TICK * 8);
    expect(resumed.followups).toHaveLength(1);
    expect(next.dsh.warnings).toEqual([]);
  });

  test("a slow close (queue cleared, the session still registered and not idle): the reply is not reported lost, and goes in once after the resume", async () => {
    const w = await world();
    const agent = w.dsh.create("session-slow-close", w.project);
    agent.hold = true;
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Slow?" })).text);
    const answer = await reply(w.server, sent.message_id, "Slowly.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    agent.status = "running";
    agent.clearQueue();
    await Bun.sleep(CHECK * 4);
    expect(w.dsh.warnings).toEqual([]);
    expect(await deliveryNow(w.server, sent.thread_id, answer.id)).toBeNull();
    await w.dsh.dispose(agent);
    const resumed = w.dsh.create("session-slow-close", w.project);
    expect(await until(() => resumed.followups.length === 1)).toBe(true);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-slow-close" });
    await Bun.sleep(TICK * 8);
    expect(resumed.followups).toHaveLength(1);
    expect(w.dsh.warnings).toEqual([]);
  });

  test("edited in the queue, then the session closes keeping its queue: the edit is not taken for a removal, and the reply is not given back for a second go", async () => {
    const w = await world();
    const agent = w.dsh.create("session-edit-close", w.project);
    agent.hold = true;
    await start(w, { deliveryCheckMs: 60_000 });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Edit?" })).text);
    const answer = await reply(w.server, sent.message_id, "Edited.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    agent.edit(agent.followups[0]!.id, "Edited, with more.");
    await w.dsh.dispose(agent, { ready: false });
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-edit-close" });
    const resumed = w.dsh.create("session-edit-close", w.project);
    await Bun.sleep(TICK * 8);
    expect(resumed.followups).toEqual([]);
    expect(w.dsh.warnings).toEqual([]);
  });

  test("a DSH that never says claimed: gone from the queue at the next look counts as taken", async () => {
    const w = await world();
    const agent = w.dsh.create("session-quiet", w.project);
    agent.silentClaims = true;
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Quiet?" })).text);
    const answer = await reply(w.server, sent.message_id, "Yes.");
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-quiet" });
  });

  test("a DSH that never says claimed, with the turn that took it still running: taken, not held until idle", async () => {
    const w = await world();
    const agent = w.dsh.create("session-quiet-busy", w.project);
    agent.silentClaims = true;
    agent.hold = true;
    await start(w, { deliveryCheckMs: CHECK });
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Busy?" })).text);
    const answer = await reply(w.server, sent.message_id, "Yes.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
    agent.status = "running";
    agent.claim(agent.followups[0]!.id);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "dsh", session: "session-quiet-busy" });
    expect(agent.status).toBe("running");
  });
});

describe("DeepSeek Harness: a subagent's shell sends as the session it works for", () => {
  test("Plannotator adds DSH_PLANNOTATOR_SESSION_ID to each model shell: the parent's id for a subagent, the session's own otherwise", async () => {
    const w = await world();
    const contributors: { name: string; variables: Record<string, { description: string }>; resolve(execution: { agent?: DshInboxAgent }): Record<string, string> }[] = [];
    w.dsh.services.shellEnv = { register: (contributor: (typeof contributors)[number]) => void contributors.push(contributor) };
    const parent = w.dsh.create("session-top", w.project);
    const child = w.dsh.create("session-sub", w.project, { parentSession: "session-top", origin: "subagent", delegationDepth: 1 });
    await start(w);
    expect(contributors).toHaveLength(1);
    expect(Object.keys(contributors[0]!.variables)).toEqual([DSH_ROOT_SESSION_ENV, DSH_ROOT_FOR_ENV]);
    // Each names the session it was set for, so a shell that inherits it into another session (a nested dsh) does not use it.
    expect(contributors[0]!.resolve({ agent: child })).toEqual({ [DSH_ROOT_SESSION_ENV]: "session-top", [DSH_ROOT_FOR_ENV]: "session-sub" });
    expect(contributors[0]!.resolve({ agent: parent })).toEqual({ [DSH_ROOT_SESSION_ENV]: "session-top", [DSH_ROOT_FOR_ENV]: "session-top" });
    // The session header's id is what DSH puts in DSH_SESSION_ID.
    child.session.header.id = "header-sub";
    expect(contributors[0]!.resolve({ agent: child })).toEqual({ [DSH_ROOT_SESSION_ENV]: "session-top", [DSH_ROOT_FOR_ENV]: "header-sub" });
    expect(contributors[0]!.resolve({})).toEqual({});
  });

  test("a shellEnv that becomes active later still gets the variable", async () => {
    const w = await world();
    const contributors: unknown[] = [];
    w.dsh.services.shellEnv = { register: (contributor: unknown) => void contributors.push(contributor) };
    w.dsh.late.add("shellEnv");
    w.dsh.create("session-late-env", w.project);
    expect(await setupDshInbox(w.dsh.cordis, { env: ON, dataDir: w.dataDir, tickMs: TICK, version: null }).then((inbox) => (inbox && inboxes.push(inbox), inbox))).not.toBeNull();
    expect(contributors).toEqual([]);
    w.dsh.provide("shellEnv");
    expect(contributors).toHaveLength(1);
  });
});

// index.ts's `apply` is plugin.ts's applyPlannotator without test hooks.
describe("DeepSeek Harness: the plugin's load and unload", () => {
  const deps = (w: Awaited<ReturnType<typeof world>>) => ({ env: ON, dataDir: w.dataDir, tickMs: TICK, version: null });

  test("agents and tools active after the plugin applies: the Inbox connection starts then, not 'no agents service'", async () => {
    const w = await world();
    for (const name of DSH_INBOX_SERVICES) w.dsh.late.add(name);
    const agent = w.dsh.create("session-late", w.project);
    const started: (DshInbox | null)[] = [];
    await applyPlannotator(w.dsh.cordis as never, { planReview: false }, deps(w), (inbox) => void started.push(inbox));
    expect(started).toEqual([]);
    expect(w.dsh.tools).toEqual([]);
    w.dsh.provide("agents");
    // Agents alone is not enough: the tool needs `tools`.
    await Bun.sleep(300);
    expect(started).toEqual([]);
    expect(w.dsh.warnings).toEqual([]);
    w.dsh.provide("tools");
    expect(await until(() => started.length === 1)).toBe(true);
    const inbox = started[0]!;
    inboxes.push(inbox!);
    expect(w.dsh.warnings.filter((line) => line.includes("no agents service"))).toEqual([]);
    expect(w.dsh.tools.map((t) => t.name)).toEqual(["plannotator_inbox"]);
    const sent = idsOf((await w.dsh.call(agent, { action: "send_message", body: "Late?" })).text);
    await reply(w.server, sent.message_id, "On time.");
    expect(await until(() => agent.followups.length === 1)).toBe(true);
  });

  test("a service it needs goes away (replaced): the old wakes stop, and the connection starts again when it is back", async () => {
    const w = await world();
    w.dsh.create("session-swap", w.project);
    const started: (DshInbox | null)[] = [];
    await applyPlannotator(w.dsh.cordis as never, { planReview: false }, deps(w), (inbox) => void started.push(inbox));
    expect(await until(() => started.length === 1)).toBe(true);
    const first = started[0]!.wakes.get("session-swap")!;
    w.dsh.withdraw("agents");
    expect(first.isDisposed).toBe(true);
    w.dsh.provide("agents");
    expect(await until(() => started.length === 2)).toBe(true);
    inboxes.push(started[1]!);
    expect(started[1]!.wakes.get("session-swap")!.isDisposed).toBe(false);
  });

  test("unloading the plugin stops every wake it started", async () => {
    const w = await world();
    w.dsh.create("session-reload", w.project);
    const started: (DshInbox | null)[] = [];
    await applyPlannotator(w.dsh.cordis as never, { planReview: false }, deps(w), (inbox) => void started.push(inbox));
    expect(await until(() => started.length === 1)).toBe(true);
    const wake = started[0]!.wakes.get("session-reload")!;
    expect(wake.isDisposed).toBe(false);
    w.dsh.unload();
    expect(wake.isDisposed).toBe(true);
  });

  test("unloaded while the Inbox's tools are still being read: what started is stopped, nothing is kept", async () => {
    const w = await world();
    w.dsh.create("session-early", w.project);
    let release: (tools: null) => void = () => {};
    const gate = new Promise<null>((resolve) => (release = resolve));
    const real = (await import("../../packages/shared/inbox/agent-link")).discoverInboxTools;
    const started: (DshInbox | null)[] = [];
    const applied = applyPlannotator(w.dsh.cordis as never, { planReview: false }, { ...deps(w), discover: async (dir) => (await gate, real(dir)) }, (inbox) => void started.push(inbox));
    w.dsh.unload();
    release(null);
    await applied;
    expect(await until(() => started.length === 1)).toBe(true);
    expect(started).toEqual([null]);
    expect(w.dsh.tools).toEqual([]);
  });

  test("a setup that throws is logged, and apply never rejects", async () => {
    const w = await world();
    const broken: DshInboxContext = {
      ...w.dsh.ctx,
      on: (event) => {
        if (event.startsWith("agent/")) throw new Error("bus is closed");
        return undefined;
      },
    };
    await expect(applyPlannotator(broken as never, { planReview: false }, deps(w))).resolves.toBeUndefined();
    expect(w.dsh.warnings.some((line) => line.includes("did not start") && line.includes("bus is closed"))).toBe(true);
  });
});
