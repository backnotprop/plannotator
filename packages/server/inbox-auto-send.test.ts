/**
 * A reply waiting on a busy agent goes into its running turn by itself after
 * the wait (owner approval "inbox-busy-agent-reply", 2026-10-21): the server's
 * timer, proved through the real doors with the wait shortened
 * (`autoSendAfterMs`): the agent's MCP send with the wake meta, the window's
 * reply route, the connection's poll (busy, `send_now`) and its
 * `send_now_failed`, the sessions route, the list row, and an Inbox restart
 * on the same data dir. The wait counts from the first time the server saw
 * the session busy and able to take the item, never from `created_at`.
 * Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_AUTO_SEND_AFTER_MS, type InboxListRow, type InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_SEND_NOW_POLL_FIELD, INBOX_WAKES_META_KEY, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { INBOX_ASKER_STEER_GRACE_MS } from "./inbox-sessions";
import { INBOX_AUTO_SEND_SWEEP_MS, startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const WAIT = 600;
const SWEEP = 50;

async function start(dataDir: string, options: { autoSendAfterMs?: number } = { autoSendAfterMs: WAIT }) {
  const server = await startInboxServer({ dataDir, ...options, autoSendSweepMs: SWEEP });
  servers.push(server);
  const client = new Client({ name: "inbox-auto-send-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client };
}

async function setup(options?: { autoSendAfterMs?: number; sessionsNow?: () => number }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-auto-send-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  return { ...(await start(dataDir, options)), project, dataDir };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function agentSends(client: Client, project: string, session: string, body: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: "claude-code" },
    _meta: { [INBOX_WAKES_META_KEY]: true },
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

function bridge(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
}

/** One poll of the session's connection, as the Claude Code mod sends it. */
async function poll(server: InboxServer, session: string, project: string, state: { busy: boolean; sendNow: boolean }) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, {
    session,
    host: "claude-code",
    project_path: project,
    waitMs: 0,
    busy: state.busy,
    ...(state.sendNow ? { [INBOX_SEND_NOW_POLL_FIELD]: true } : {}),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

async function reply(server: InboxServer, messageId: string, words: string) {
  const response = await fetch(`${base(server)}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k-${messageId}`, words }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { reply: { id: string; created_at: string } }).reply;
}

async function startThread(server: InboxServer, session: string, body: string) {
  const response = await fetch(`${base(server)}/api/inbox/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, to: { host: "claude-code", session }, body, idempotency_key: `t-${body}` }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { thread_id: string; message: { id: string; created_at: string } });
}

async function moveTo(server: InboxServer, messageId: string, session: string) {
  const response = await fetch(`${base(server)}/api/inbox/messages/${messageId}/to`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, to: { host: "claude-code", session } }),
  });
  expect(response.status).toBe(200);
}

async function waitsOf(server: InboxServer, threadId: string, session: string) {
  const known = (await (await fetch(`${base(server)}/api/inbox/threads/${threadId}/sessions?asker=${session}`)).json()) as {
    asker: { connection: { waits: Record<string, { since: string; auto_since: string | null }> } | null };
  };
  return known.asker.connection?.waits ?? {};
}

async function messageOf(server: InboxServer, threadId: string, id: string) {
  const thread = ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
  return thread.messages.find((m) => m.id === id)!;
}

async function row(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const model = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: InboxListRow[] }[] };
  return model.sections.flatMap((section) => section.threads).find((r) => r.thread_id === threadId)!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the Inbox puts a waiting reply into a busy session's turn by itself", () => {
  test("not before the wait; at it, as if Send now was pressed (the poll hands it with `now`); never twice, not after a failed attempt", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-a", "CSV or Parquet?");
    await poll(server, "ses-a", project, { busy: true, sendNow: true });
    const sent = await reply(server, asked.message_id, "Parquet.");

    // Before the wait: handed out without `now`, and the row says how long it waited and when it goes in,
    // from the server's clock (the first time it saw the session busy and able to take it), not created_at.
    const early = await poll(server, "ses-a", project, { busy: true, sendNow: true });
    expect(early.map((c) => c.id)).toEqual([sent.id]);
    expect(early[0]!.now).toBeUndefined();
    const clock = (await waitsOf(server, asked.thread_id, "ses-a"))[sent.id]!;
    expect(Date.parse(clock.since)).toBeGreaterThanOrEqual(Date.parse(sent.created_at));
    expect(clock.auto_since).toBe(clock.since);
    expect((await row(server, asked.thread_id)).delivery).toMatchObject({
      state: "queued",
      reason: "working",
      send_now: true,
      steerable: true,
      waiting_since: clock.since,
      auto_send_at: new Date(Date.parse(clock.since) + WAIT).toISOString(),
    });
    expect((await messageOf(server, asked.thread_id, sent.id)).deliver_now_at ?? null).toBeNull();

    // The timer, with no poll in between (the session stays live for its poll window).
    await sleep(WAIT + SWEEP * 4);
    const marked = await messageOf(server, asked.thread_id, sent.id);
    expect(marked.deliver_now_by).toBe("auto");
    expect(typeof marked.deliver_now_at).toBe("string");
    const now = await poll(server, "ses-a", project, { busy: true, sendNow: true });
    expect(now.map((c) => [c.id, c.now])).toEqual([[sent.id, true]]);
    expect((await row(server, asked.thread_id)).delivery).toMatchObject({ state: "sending", reason: "sending_now", auto_after_min: 0 });

    // The engine refused the row: it waits for idle as before, and the Inbox never tries again by itself.
    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "send_now_failed", id: sent.id })).status).toBe(200);
    await sleep(WAIT + SWEEP * 4);
    const after = await messageOf(server, asked.thread_id, sent.id);
    expect(after).toMatchObject({ deliver_now_at: null, deliver_now_by: "auto" });
    const later = await poll(server, "ses-a", project, { busy: true, sendNow: true });
    expect(later[0]!.now).toBeUndefined();
    expect((await row(server, asked.thread_id)).delivery).toMatchObject({ state: "queued", auto_send_at: null, steerable: true });
  });

  test("never where the connection cannot take it mid-turn, and never for an idle session (it is delivered as a turn anyway)", async () => {
    const { server, client, project } = await setup();
    const stuck = await agentSends(client, project, "ses-old", "Round half-even?");
    await poll(server, "ses-old", project, { busy: true, sendNow: false });
    const sentStuck = await reply(server, stuck.message_id, "Yes.");
    const idle = await agentSends(client, project, "ses-idle", "Ship it?");
    await poll(server, "ses-idle", project, { busy: false, sendNow: true });
    const sentIdle = await reply(server, idle.message_id, "Ship.");

    for (let i = 0; i < 3; i++) {
      await sleep((WAIT + SWEEP * 4) / 2);
      await poll(server, "ses-old", project, { busy: true, sendNow: false });
      await poll(server, "ses-idle", project, { busy: false, sendNow: true });
    }
    expect((await messageOf(server, stuck.thread_id, sentStuck.id)).deliver_now_by ?? null).toBeNull();
    expect((await messageOf(server, idle.thread_id, sentIdle.id)).deliver_now_by ?? null).toBeNull();
    // The stuck one says how long it waited on the busy session, grey, with no countdown (no auto clock).
    const stuckClock = (await waitsOf(server, stuck.thread_id, "ses-old"))[sentStuck.id]!;
    expect(stuckClock.auto_since).toBeNull();
    expect((await row(server, stuck.thread_id)).delivery).toMatchObject({ reason: "working", steerable: false, auto_send_at: null, waiting_since: stuckClock.since });
  });

  test("an Inbox restart starts the clock again: never shorter, and the first busy poll puts nothing in", async () => {
    const { server, client, project, dataDir } = await setup();
    const asked = await agentSends(client, project, "ses-a", "CSV or Parquet?");
    await poll(server, "ses-a", project, { busy: true, sendNow: true });
    const sent = await reply(server, asked.message_id, "Parquet.");
    await sleep(WAIT / 2);
    expect((await messageOf(server, asked.thread_id, sent.id)).deliver_now_by ?? null).toBeNull();
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    await sleep(WAIT);

    // A new process: nothing in memory about the session or the reply's wait. It waits its whole time again.
    const { server: next } = await start(dataDir);
    const first = await poll(next, "ses-a", project, { busy: true, sendNow: true });
    expect(first.map((c) => [c.id, c.now])).toEqual([[sent.id, undefined]]);
    expect((await messageOf(next, asked.thread_id, sent.id)).deliver_now_by ?? null).toBeNull();
    await sleep(WAIT + SWEEP * 4);
    await poll(next, "ses-a", project, { busy: true, sendNow: true });
    expect((await messageOf(next, asked.thread_id, sent.id)).deliver_now_by).toBe("auto");
  });

  test("a reply left for a session that was gone waits its full time once the session is back and busy", async () => {
    const { server, client, project } = await setup();
    // The agent asked, then its session went away (it never polls); the person replies much later.
    const asked = await agentSends(client, project, "ses-gone", "CSV or Parquet?");
    const sent = await reply(server, asked.message_id, "Parquet.");
    await sleep(WAIT * 2);
    // The person resumes the session: busy at once, able to take it. Not on this poll.
    const resumed = await poll(server, "ses-gone", project, { busy: true, sendNow: true });
    expect(resumed.map((c) => [c.id, c.now])).toEqual([[sent.id, undefined]]);
    expect((await messageOf(server, asked.thread_id, sent.id)).deliver_now_by ?? null).toBeNull();
    // "Undelivered" counts from now, not from when it was sent.
    const clock = (await waitsOf(server, asked.thread_id, "ses-gone"))[sent.id]!;
    expect(Date.parse(clock.since) - Date.parse(sent.created_at)).toBeGreaterThanOrEqual(WAIT * 2);
    await sleep(WAIT / 2);
    expect((await messageOf(server, asked.thread_id, sent.id)).deliver_now_by ?? null).toBeNull();
    await sleep(WAIT / 2 + SWEEP * 4);
    await poll(server, "ses-gone", project, { busy: true, sendNow: true });
    expect((await messageOf(server, asked.thread_id, sent.id)).deliver_now_by).toBe("auto");
  });

  test("a message moved to a busy session starts its wait there: no `now` on that session's first poll, and an old mark does not carry over", async () => {
    // The sessions' clock starts behind, then catches up, so A has stopped by the time of the move, with the store's clock untouched.
    let behind = INBOX_ASKER_STEER_GRACE_MS + 1;
    const { server, project } = await setup({ autoSendAfterMs: WAIT, sessionsNow: () => Date.now() - behind });
    await poll(server, "ses-a", project, { busy: true, sendNow: true });
    await poll(server, "ses-b", project, { busy: true, sendNow: true });
    const thread = await startThread(server, "ses-a", "Try the new parser.");
    // It waited on A long enough to be marked; then the person moves it to B.
    for (let i = 0; i < 3; i++) {
      await sleep((WAIT + SWEEP * 4) / 2);
      await poll(server, "ses-a", project, { busy: true, sendNow: true });
      await poll(server, "ses-b", project, { busy: true, sendNow: true });
    }
    expect((await messageOf(server, thread.thread_id, thread.message.id)).deliver_now_by).toBe("auto");
    // A stopped: a move needs the session it waits on to have ended, also past the grace of a steer it was handed.
    behind = 0;
    await poll(server, "ses-b", project, { busy: true, sendNow: true });
    await moveTo(server, thread.message.id, "ses-b");
    const moved = await messageOf(server, thread.thread_id, thread.message.id);
    expect(moved.deliver_now_at ?? null).toBeNull();
    expect(moved.deliver_now_by ?? null).toBeNull();
    const first = await poll(server, "ses-b", project, { busy: true, sendNow: true });
    expect(first.map((c) => [c.id, c.now])).toEqual([[thread.message.id, undefined]]);
    // Its clock on B starts now; it goes in by itself after B's own wait.
    const clock = (await waitsOf(server, thread.thread_id, "ses-b"))[thread.message.id]!;
    expect(Date.parse(clock.since)).toBeGreaterThan(Date.parse(thread.message.created_at) + WAIT);
    await sleep(WAIT + SWEEP * 4);
    const later = await poll(server, "ses-b", project, { busy: true, sendNow: true });
    expect(later.map((c) => [c.id, c.now])).toEqual([[thread.message.id, true]]);
  });

  test("delivered after the mark: into the running turn says so; after the session went idle (its own Ask held the turn) it says the turn ended", async () => {
    const { server, client, project } = await setup();
    const a = await agentSends(client, project, "ses-a", "CSV or Parquet?");
    const b = await agentSends(client, project, "ses-b", "Ship it?");
    await poll(server, "ses-a", project, { busy: true, sendNow: true });
    await poll(server, "ses-b", project, { busy: true, sendNow: true });
    const sentA = await reply(server, a.message_id, "Parquet.");
    const sentB = await reply(server, b.message_id, "Ship.");
    await sleep(WAIT + SWEEP * 4);
    expect((await messageOf(server, a.thread_id, sentA.id)).deliver_now_by).toBe("auto");
    expect((await messageOf(server, b.thread_id, sentB.id)).deliver_now_by).toBe("auto");
    // A: steered into the running turn.
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "delivered", id: sentA.id });
    expect((await messageOf(server, a.thread_id, sentA.id)).delivery!.into_turn).toBe(true);
    expect((await row(server, a.thread_id)).delivery).toMatchObject({ state: "delivered", auto_after_min: 0 });
    // B: its session went idle first (the turn ended), then took it as a new turn.
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-b", host: "claude-code", type: "state", busy: false });
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-b", host: "claude-code", type: "delivered", id: sentB.id });
    expect((await messageOf(server, b.thread_id, sentB.id)).delivery!.into_turn).toBe(false);
    const rowB = (await row(server, b.thread_id)).delivery!;
    expect(rowB).toMatchObject({ state: "delivered", turn_ended: true });
    expect(rowB.auto_after_min).toBeUndefined();
  });

  test("the default wait is 5 minutes, and the sessions route says so for the line's countdown", async () => {
    expect(INBOX_AUTO_SEND_AFTER_MS).toBe(5 * 60_000);
    expect(INBOX_AUTO_SEND_SWEEP_MS).toBeLessThanOrEqual(10_000);
    const { server, client, project } = await setup({});
    const asked = await agentSends(client, project, "ses-a", "CSV or Parquet?");
    await poll(server, "ses-a", project, { busy: true, sendNow: true });
    const sent = await reply(server, asked.message_id, "Parquet.");
    await sleep(SWEEP * 4);
    expect((await messageOf(server, asked.thread_id, sent.id)).deliver_now_by ?? null).toBeNull();
    const known = (await (await fetch(`${base(server)}/api/inbox/threads/${asked.thread_id}/sessions?asker=ses-a`)).json()) as {
      asker: { connection: { auto_send_after_ms: number } };
    };
    expect(known.asker.connection.auto_send_after_ms).toBe(INBOX_AUTO_SEND_AFTER_MS);
  });
});
