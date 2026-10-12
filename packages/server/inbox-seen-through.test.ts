/**
 * The look capped at what the window showed (design record
 * "inbox-new-in-open-thread", approved 2026-10-12; not in this repo):
 * `POST /api/inbox/threads/:id/seen` takes an optional `through_seq`, the seq
 * of the newest message the window actually showed, and the look stops there.
 * Through the server's real doors: a running Inbox on loopback, the MCP SDK
 * client for the agent, real `fetch` for the window. The window's side is
 * proved in packages/inbox/seenOnSight.test.tsx and
 * tests/e2e/inbox-seen-on-sight.spec.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-seen-through-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-seen-through-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (body: string) => {
    const result = (await client.callTool({ name: "send_message", arguments: { project_path: project, body, agent_session: "ses_A" } })) as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent: { thread_id: string; message_id: string; cursor: number };
    };
    if (result.isError) throw new Error(result.content[0]!.text);
    return result.structuredContent;
  };
  return { server, send };
}

function seen(server: InboxServer, threadId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}/seen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function row(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}`);
  return ((await response.json()) as { row: InboxListRow }).row;
}

async function windowThread(server: InboxServer, threadId: string): Promise<{ thread: InboxThread; cursor: number }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}`);
  return (await response.json()) as { thread: InboxThread; cursor: number };
}

test("through_seq stops the look at that message: a later agent message stays new", async () => {
  const { server, send } = await world();
  const first = await send("The refund webhook is wired.");
  await send("Retries are on, three attempts.");
  const capped = await seen(server, first.thread_id, { through_seq: first.cursor });
  expect(capped.status).toBe(200);
  expect(((await capped.json()) as { thread: InboxListRow }).thread).toMatchObject({ section: "new", unseen: 1, unread: true });
});

test("the race: a message that lands after the window read the thread is not marked seen by the look", async () => {
  const { server, send } = await world();
  const first = await send("The refund webhook is wired.");
  const read = await windowThread(server, first.thread_id);
  const shown = Math.max(...read.thread.messages.map((m) => m.seq ?? 0));
  // The agent writes between the window's read and its look.
  await send("One more thing: the 409 path retries.");
  expect((await seen(server, first.thread_id, { through_seq: shown })).status).toBe(200);
  expect(await row(server, first.thread_id)).toMatchObject({ section: "new", unseen: 1 });
  // Seen on sight: the window shows it and records the look up to it.
  const after = await windowThread(server, first.thread_id);
  const newest = Math.max(...after.thread.messages.map((m) => m.seq ?? 0));
  expect((await seen(server, first.thread_id, { through_seq: newest })).status).toBe(200);
  expect(await row(server, first.thread_id)).toMatchObject({ section: "quiet", unseen: 0, unread: false });
});

test("without through_seq (an older window, the phone door): every agent message so far, as before", async () => {
  const { server, send } = await world();
  const first = await send("The refund webhook is wired.");
  await send("Retries are on.");
  expect((await seen(server, first.thread_id, {})).status).toBe(200);
  expect(await row(server, first.thread_id)).toMatchObject({ section: "quiet", unseen: 0 });
  // null counts as absent.
  await send("And the dashboard shows them.");
  expect((await seen(server, first.thread_id, { through_seq: null })).status).toBe(200);
  expect(await row(server, first.thread_id)).toMatchObject({ unseen: 0 });
});

test("a through_seq behind the recorded look never lowers it and writes nothing", async () => {
  const { server, send } = await world();
  const first = await send("The refund webhook is wired.");
  await send("Retries are on.");
  expect((await seen(server, first.thread_id, {})).status).toBe(200);
  const before = await windowThread(server, first.thread_id);
  expect((await seen(server, first.thread_id, { through_seq: first.cursor })).status).toBe(200);
  const after = await windowThread(server, first.thread_id);
  expect(after.cursor).toBe(before.cursor);
  expect(await row(server, first.thread_id)).toMatchObject({ unseen: 0 });
  // Zero is a valid seq and covers nothing.
  expect((await seen(server, first.thread_id, { through_seq: 0 })).status).toBe(200);
  expect((await windowThread(server, first.thread_id)).cursor).toBe(before.cursor);
});

test("a through_seq past the newest message is the newest message", async () => {
  const { server, send } = await world();
  const first = await send("The refund webhook is wired.");
  await send("Retries are on.");
  expect((await seen(server, first.thread_id, { through_seq: 9_000_000 })).status).toBe(200);
  expect(await row(server, first.thread_id)).toMatchObject({ section: "quiet", unseen: 0 });
});

test("a through_seq that is not a whole number of 0 or more is refused and writes nothing", async () => {
  const { server, send } = await world();
  const first = await send("The refund webhook is wired.");
  const before = (await windowThread(server, first.thread_id)).cursor;
  for (const bad of ["12", -1, 1.5, true, [3]]) {
    const response = await seen(server, first.thread_id, { through_seq: bad });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string; field: string })).toMatchObject({ code: "validation_error", field: "through_seq" });
  }
  expect((await windowThread(server, first.thread_id)).cursor).toBe(before);
  expect(await row(server, first.thread_id)).toMatchObject({ unseen: 1 });
});
