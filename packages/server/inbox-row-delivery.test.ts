import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_HELD_POLL_FIELD, INBOX_SEND_NOW_POLL_FIELD, INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const aborts: AbortController[] = [];

afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-row-delivery-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-row-delivery-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

function bridge(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
}

async function row(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const model = (await (await fetch(`${base(server)}/api/inbox/threads?archived=exclude`)).json()) as { sections: { threads: InboxListRow[] }[] };
  return model.sections.flatMap((section) => section.threads).find((r) => r.thread_id === threadId)!;
}

function stream(server: InboxServer, query: string) {
  const abort = new AbortController();
  aborts.push(abort);
  const events: string[] = [];
  const done = (async () => {
    const response = await fetch(`${base(server)}/api/inbox/events?${query}`, { signal: abort.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
      for (let cut = text.indexOf("\n\n"); cut >= 0; cut = text.indexOf("\n\n")) {
        const frame = text.slice(0, cut);
        text = text.slice(cut + 2);
        const name = /^event: (.+)$/m.exec(frame)?.[1];
        if (name) events.push(name);
      }
    }
  })().catch(() => {});
  return { events, done };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

describe("the row's delivery through the server", () => {
  test("a reply to a busy session reads queued with Send now on its row; the turn ending moves it to sending, and the windows are told", async () => {
    const { server, client, project } = await setup();
    const sent = (
      await client.callTool({
        name: "send_message",
        arguments: { body: "Shipped. Anything else?", project_path: project, agent_session: "ses-a", agent_host: "claude-code" },
        _meta: { [INBOX_WAKES_META_KEY]: true },
      })
    ).structuredContent as { message_id: string; thread_id: string };

    const window = stream(server, "cursor=0&window=win-0123456789abcdef&permission=granted&origin=http%3A%2F%2Flocalhost");
    const door = stream(server, "cursor=0");
    await until(() => window.events.includes("hello") && door.events.includes("hello"));

    const poll = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-a", host: "claude-code", project_path: project, waitMs: 0, busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true });
    expect(poll.status).toBe(200);
    const replied = await fetch(`${base(server)}/api/inbox/messages/${sent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "k1", words: "Bump the version too." }),
    });
    expect(replied.status).toBe(200);
    const reply = ((await replied.json()) as { reply: { id: string } }).reply;

    const queued = await row(server, sent.thread_id);
    expect(queued.section).toBe("sent");
    expect(queued.delivery).toMatchObject({ kind: "reply", state: "queued", reason: "working", send_now: true, message_id: reply.id, host: "claude-code", at: null });
    const asker = (await (await fetch(`${base(server)}/api/inbox/threads/${sent.thread_id}/sessions?asker=ses-a`)).json()) as {
      asker: { connection: { busy: boolean; send_now: boolean } };
    };
    expect(asker.asker.connection).toMatchObject({ busy: true, send_now: true });

    const before = window.events.filter((e) => e === "deliveries").length;
    const state = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "state", busy: false });
    expect(state.status).toBeLessThan(300);
    await until(() => window.events.filter((e) => e === "deliveries").length > before);
    expect((await row(server, sent.thread_id)).delivery).toMatchObject({ state: "sending", reason: "idle", send_now: false });
    expect(door.events).not.toContain("deliveries");

    const ack = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "delivered", id: reply.id });
    expect(ack.status).toBeLessThan(300);
    const delivered = (await row(server, sent.thread_id)).delivery!;
    expect(delivered).toMatchObject({ state: "delivered", reason: "delivered" });
    expect(typeof delivered.at).toBe("string");
  }, 20_000);

  test("a turn that ends and starts again between two looks of the delivery watch still tells the windows", async () => {
    const { server, client, project } = await setup();
    await client.callTool({
      name: "send_message",
      arguments: { body: "Shipped. Anything else?", project_path: project, agent_session: "ses-b", agent_host: "claude-code" },
      _meta: { [INBOX_WAKES_META_KEY]: true },
    });
    const window = stream(server, "cursor=0&window=win-fedcba9876543210&permission=granted&origin=http%3A%2F%2Flocalhost");
    await until(() => window.events.includes("hello"));
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-b", host: "claude-code", project_path: project, waitMs: 0, busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true });
    await until(() => window.events.includes("deliveries"));
    await Bun.sleep(1_500);
    const before = window.events.filter((e) => e === "deliveries").length;
    // Idle, then busy again, well inside one second: a window that read the list in between saw "sending",
    // so it must be told to read again even though the session looks as it did at the last look.
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-b", host: "claude-code", type: "state", busy: false });
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-b", host: "claude-code", type: "state", busy: true });
    await until(() => window.events.filter((e) => e === "deliveries").length > before, 3_000);
  }, 20_000);

  test("a session whose connection says Claude Code holds its replies reads stopped on the row and the thread, until the hold lifts", async () => {
    const { server, client, project } = await setup();
    const sent = (
      await client.callTool({
        name: "send_message",
        arguments: { body: "Shipped. Anything else?", project_path: project, agent_session: "ses-h", agent_host: "claude-code" },
        _meta: { [INBOX_WAKES_META_KEY]: true },
      })
    ).structuredContent as { message_id: string; thread_id: string };
    const window = stream(server, "cursor=0&window=win-0a1b2c3d4e5f6789&permission=granted&origin=http%3A%2F%2Flocalhost");
    await until(() => window.events.includes("hello"));
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-h", host: "claude-code", project_path: project, waitMs: 0, busy: false, [INBOX_SEND_NOW_POLL_FIELD]: true });
    const replied = await fetch(`${base(server)}/api/inbox/messages/${sent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "k1", words: "Bump the version too." }),
    });
    const reply = ((await replied.json()) as { reply: { id: string } }).reply;
    expect((await row(server, sent.thread_id)).delivery).toMatchObject({ state: "sending", reason: "idle" });
    const connection = async () =>
      ((await (await fetch(`${base(server)}/api/inbox/threads/${sent.thread_id}/sessions?asker=ses-h`)).json()) as { asker: { connection: { held?: boolean } } }).asker.connection;
    expect((await connection()).held).toBeUndefined();

    let before = window.events.filter((e) => e === "deliveries").length;
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-h", host: "claude-code", type: "state", busy: false, [INBOX_SEND_NOW_POLL_FIELD]: true, [INBOX_HELD_POLL_FIELD]: true });
    await until(() => window.events.filter((e) => e === "deliveries").length > before);
    expect((await row(server, sent.thread_id)).delivery).toMatchObject({ state: "queued", reason: "stopped", send_now: false, message_id: reply.id });
    expect((await connection()).held).toBe(true);
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-h", host: "claude-code", project_path: project, waitMs: 0, busy: false, [INBOX_HELD_POLL_FIELD]: true });
    expect((await row(server, sent.thread_id)).delivery).toMatchObject({ reason: "stopped" });
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-h", host: "claude-code", project_path: project, waitMs: 0, busy: false });
    expect((await row(server, sent.thread_id)).delivery).toMatchObject({ state: "sending", reason: "idle" });
    expect((await connection()).held).toBeUndefined();

    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-h", host: "claude-code", type: "state", busy: false, [INBOX_HELD_POLL_FIELD]: true });
    expect((await row(server, sent.thread_id)).delivery).toMatchObject({ reason: "stopped" });
    before = window.events.filter((e) => e === "deliveries").length;
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-h", host: "claude-code", type: "state", busy: true, [INBOX_HELD_POLL_FIELD]: false });
    await until(() => window.events.filter((e) => e === "deliveries").length > before);
    expect((await row(server, sent.thread_id)).delivery).toMatchObject({ state: "queued", reason: "working" });
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-h", host: "claude-code", type: "delivered", id: reply.id });
    expect((await row(server, sent.thread_id)).delivery).toMatchObject({ state: "delivered", reason: "delivered" });
  }, 20_000);

  test("a reply to an MCP agent (no waking connection) reads saved", async () => {
    const { server, client, project } = await setup();
    const sent = (
      await client.callTool({ name: "send_message", arguments: { body: "Which target?", project_path: project, agent_session: "ses-m", agent_host: "codex", agent_name: "Codex" } })
    ).structuredContent as { message_id: string; thread_id: string };
    await fetch(`${base(server)}/api/inbox/messages/${sent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "k1", words: "ARM." }),
    });
    expect((await row(server, sent.thread_id)).delivery).toMatchObject({ state: "saved", reason: "reads", name: "Codex" });
  }, 20_000);
});
