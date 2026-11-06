/**
 * @plannotator/cline's Inbox connection against a fake Cline plugin host and
 * a scratch Inbox (in this process, its own temp data dir, loopback).
 *
 * The fake host implements only what the plugin uses: the setup context
 * (`session.sessionId`, `cwd`, `emitEvent`, `onDispose`), `api.registerTool`,
 * and the plugin's `beforeRun` / `afterRun` hooks, which the test calls as
 * Cline does around each run. Cline is never installed or run here; the
 * end-to-end check against the real Cline CLI is cline-e2e.test.ts.
 *
 * Run: /tmp/overnight/bt.sh apps/cline-plugin/inbox.test.ts (or bun test apps/cline-plugin/inbox.test.ts)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxThread } from "../../packages/core/inbox-types";
import { startInboxServer, type InboxServer } from "../../packages/server/inbox";
import { CLINE_INBOX_HOST, setupClineInbox, type ClineInboxSession, type ClineSetupContext, type ClineToolDefinition } from "./inbox";
import { plugin } from "./index";

const roots: string[] = [];
const servers: InboxServer[] = [];
const sessions: ClineInboxSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TICK = 40;
const ON = { PLANNOTATOR_INBOX_TOOL: "1" } as NodeJS.ProcessEnv;

/** One fake Cline session as a plugin sees it: what it emits, what it registered, and its cleanups. */
class FakeCline {
  readonly emitted: { name: string; payload: { prompt?: string } }[] = [];
  readonly tools: ClineToolDefinition[] = [];
  readonly cleanups: (() => void | Promise<void>)[] = [];
  readonly api = { registerTool: (tool: ClineToolDefinition) => void this.tools.push(tool) };

  constructor(
    readonly sessionId: string | undefined,
    readonly cwd: string,
  ) {}

  ctx(): ClineSetupContext {
    return {
      ...(this.sessionId ? { session: { sessionId: this.sessionId } } : {}),
      cwd: this.cwd,
      workspaceInfo: { rootPath: this.cwd },
      client: { name: "cline-cli" },
      emitEvent: (name, payload) => void this.emitted.push({ name, payload: payload as { prompt?: string } }),
      onDispose: (cleanup) => void this.cleanups.push(cleanup),
    };
  }

  prompts(): string[] {
    return this.emitted.filter((event) => event.name === "queue_message").map((event) => event.payload.prompt ?? "");
  }

  /** Cline stops the worker (the session ended, or no call for 30 minutes): its onDispose cleanups run. */
  async stopWorker(): Promise<void> {
    for (const cleanup of this.cleanups.splice(0)) await cleanup();
  }

  async call(args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.name === "plannotator_inbox");
    if (!tool) throw new Error("plannotator_inbox is not registered");
    return tool.execute(args, {});
  }
}

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-cline-inbox-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return { root, project, dataDir, server };
}

async function start(w: Awaited<ReturnType<typeof world>>, cline: FakeCline, deps: Parameters<typeof setupClineInbox>[2] = {}) {
  const session = await setupClineInbox(cline.api, cline.ctx(), { env: ON, dataDir: w.dataDir, tickMs: TICK, version: "9.9.9", deliveryWaitMs: 2_000, ...deps });
  if (session) sessions.push(session);
  return session;
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

function post(server: InboxServer, path: string, body: Record<string, unknown>) {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
}

async function reply(server: InboxServer, messageId: string, words: string): Promise<{ id: string }> {
  const response = await post(server, `/api/inbox/messages/${messageId}/reply`, { idempotency_key: `k-${messageId}-${words}`, words });
  expect(response.status).toBe(200);
  return ((await response.json()) as { reply: { id: string } }).reply;
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

/** The To picker's model: live sessions by project. */
async function liveSessions(server: InboxServer): Promise<{ project: { root: string }; sessions: { session: string; host: string; busy: boolean | null }[] }[]> {
  return ((await (await fetch(`${base(server)}/api/inbox/sessions`)).json()) as { projects: never }).projects;
}

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

describe("Cline: the Inbox connection (fake Cline plugin host)", () => {
  test("an idle session is listed in the To picker under its folder, and a New message to it starts one turn there", async () => {
    const w = await world();
    const cline = new FakeCline("1793987197190_j62v5", w.project);
    const session = await start(w, cline);
    expect(session).not.toBeNull();
    // Listed as a live Cline session in its project, idle.
    expect(
      await until(async () => (await liveSessions(w.server)).some((group) => group.project.root === w.project && group.sessions.some((s) => s.session === cline.sessionId && s.host === "cline"))),
    ).toBe(true);

    const response = await post(w.server, "/api/inbox/messages", { to: { host: CLINE_INBOX_HOST, session: cline.sessionId }, body: "Idea: retry the webhook on a 409.", idempotency_key: "c1" });
    expect(response.status).toBe(200);
    const sent = (await response.json()) as { thread_id: string; message: { id: string } };
    expect(await until(() => cline.prompts().length > 0)).toBe(true);
    expect(cline.prompts()[0]).toStartWith("Plannotator Inbox: Idea: retry the webhook on a 409");
    expect(cline.prompts()[0]).toContain(`(${sent.message.id})`);
    // Cline starts the turn: the run that begins now is ours, and the thread says it was delivered to this session.
    session!.beforeRun({ snapshot: { agentId: "agent-1" } });
    expect(await deliveryOf(w.server, sent.thread_id, sent.message.id)).toMatchObject({ host: "cline", session: cline.sessionId });
    session!.afterRun({ snapshot: { agentId: "agent-1" } });
    await Bun.sleep(TICK * 8);
    expect(cline.prompts()).toHaveLength(1);
  });

  test("the agent's message goes through the plugin's tool, signed as the session; the reply waits while a run goes, then goes in once", async () => {
    const w = await world();
    const cline = new FakeCline("ses-a", w.project);
    const session = (await start(w, cline))!;
    // One tool, never retried by Cline (a retried send would send twice).
    expect(cline.tools.map((t) => [t.name, t.retryable, t.maxRetries])).toEqual([["plannotator_inbox", false, 0]]);
    session.beforeRun({ snapshot: { agentId: "agent-1" } });
    const sent = idsOf(await cline.call({ action: "send_message", body: "Drafted the release notes. Ship today?" }));
    const message = (await thread(w.server, sent.thread_id)).messages[0]!;
    expect(message.author).toMatchObject({ kind: "agent", host: "cline", session: "ses-a", name: "Cline" });
    expect(message.wakes).toBe(true);

    const answer = await reply(w.server, sent.message_id, "Yes, ship it.");
    await Bun.sleep(TICK * 10);
    // The run is still going: nothing goes into it.
    expect(cline.prompts()).toEqual([]);
    session.afterRun({ snapshot: { agentId: "agent-1" } });
    expect(await until(() => cline.prompts().length > 0)).toBe(true);
    expect(cline.prompts()[0]).toContain("Yes, ship it.");
    session.beforeRun({ snapshot: { agentId: "agent-1" } });
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ host: "cline", session: "ses-a" });
    session.afterRun({ snapshot: { agentId: "agent-1" } });
    await Bun.sleep(TICK * 8);
    expect(cline.prompts()).toHaveLength(1);
  });

  test("a subagent's run ending does not make the session idle: the reply waits for the parent's run to end", async () => {
    const w = await world();
    const cline = new FakeCline("ses-sub", w.project);
    const session = (await start(w, cline))!;
    const sent = idsOf(await cline.call({ action: "send_message", body: "Splitting the migration across two helpers." }));
    session.beforeRun({ snapshot: { agentId: "parent" } });
    session.beforeRun({ snapshot: { agentId: "helper" } });
    session.afterRun({ snapshot: { agentId: "helper" } });
    await reply(w.server, sent.message_id, "Fine.");
    await Bun.sleep(TICK * 10);
    expect(cline.prompts()).toEqual([]);
    session.afterRun({ snapshot: { agentId: "parent" } });
    expect(await until(() => cline.prompts().length === 1)).toBe(true);
  });

  test("a prompt whose run never starts counts as taken after the wait (it is in Cline's queue), and is not sent again", async () => {
    const w = await world();
    const cline = new FakeCline("ses-q", w.project);
    await start(w, cline, { deliveryWaitMs: 300 });
    const sent = idsOf(await cline.call({ action: "send_message", body: "Done with the parser." }));
    const answer = await reply(w.server, sent.message_id, "Thanks.");
    expect(await until(() => cline.prompts().length === 1)).toBe(true);
    expect(await deliveryOf(w.server, sent.thread_id, answer.id)).toMatchObject({ session: "ses-q" });
    await Bun.sleep(TICK * 10);
    expect(cline.prompts()).toHaveLength(1);
  });

  test("Cline stops the worker: the wake stops; the next setup for the same session (the person typed) delivers what waited, once", async () => {
    const w = await world();
    const first = new FakeCline("ses-idle", w.project);
    await start(w, first);
    const sent = idsOf(await first.call({ action: "send_message", body: "Waiting on the API key." }));
    await first.stopWorker();
    await reply(w.server, sent.message_id, "Added it to .env.");
    await Bun.sleep(TICK * 10);
    expect(first.prompts()).toEqual([]);
    // A fresh worker: setup runs again for the same session, then the person's own run.
    const again = new FakeCline("ses-idle", w.project);
    const session = (await start(w, again))!;
    session.beforeRun({ snapshot: { agentId: "agent-1" } });
    await Bun.sleep(TICK * 6);
    expect(again.prompts()).toEqual([]);
    session.afterRun({ snapshot: { agentId: "agent-1" } });
    expect(await until(() => again.prompts().length === 1)).toBe(true);
    expect(again.prompts()[0]).toContain("Added it to .env.");
  });

  test("starts nothing without a session (Cline reading what the plugin registers), with the switch off, or before the Inbox ever ran", async () => {
    const w = await world();
    const sessionless = new FakeCline(undefined, w.project);
    expect(await start(w, sessionless)).toBeNull();
    expect(sessionless.tools).toEqual([]);

    const off = new FakeCline("ses-off", w.project);
    expect(await start(w, off, { env: { PLANNOTATOR_INBOX_TOOL: "0" } as NodeJS.ProcessEnv })).toBeNull();
    expect(off.tools).toEqual([]);

    const never = new FakeCline("ses-never", w.project);
    expect(await start(w, never, { dataDir: join(w.root, "no-inbox-here") })).toBeNull();
    expect(never.tools).toEqual([]);
    await Bun.sleep(TICK * 4);
    expect((await liveSessions(w.server)).flatMap((group) => group.sessions)).toEqual([]);
  });

  test("the plugin object: a session-less setup registers nothing, and a hook with no session never throws", async () => {
    const cline = new FakeCline(undefined, tmpdir());
    await plugin.setup(cline.api, cline.ctx());
    expect(cline.tools).toEqual([]);
    expect(() => plugin.hooks.beforeRun({})).not.toThrow();
    expect(() => plugin.hooks.afterRun({})).not.toThrow();
  });
});
