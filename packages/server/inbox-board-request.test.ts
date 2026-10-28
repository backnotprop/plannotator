/**
 * Compose's Board chip (approval "inbox-compose-board-chip"), through the
 * server's real doors: a Send with `board_request` stores the flag on the
 * person's message and never in its words; everything the agent receives for
 * that message (the delivered turn, read_thread, wait_for_reply) carries the
 * Board request block once; nothing else does. Every test uses its own temp
 * data dir and decides the Board itself; the connections are plain HTTP calls
 * with the registry's token, never a real agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_BOARD_REQUEST_OPEN, INBOX_CARD_ACTION_ON, inboxBoardRequestBlock, inboxId, type InboxDraft, type InboxMessage, type InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, inboxWakeText, parseInboxBridgeCommands, type InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { INBOX_CODEX_MESSAGE_MAX_BYTES, codexQueueMessage } from "./inbox-codex-wake";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(board: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-board-request-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), board });
  servers.push(server);
  const client = new Client({ name: "inbox-board-request-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function poll(server: InboxServer, session: string, project: string) {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false }),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

function post(server: InboxServer, path: string, body: Record<string, unknown>) {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
}

async function send(server: InboxServer, body: Record<string, unknown>): Promise<{ message: InboxMessage; replayed: boolean }> {
  const response = await post(server, "/api/inbox/messages", { to: { session: "ses-a" }, ...body });
  expect(response.status).toBe(200);
  return (await response.json()) as never;
}

async function readThreadText(client: Client, threadId: string, session = "ses-a"): Promise<string> {
  const result = (await client.callTool({ name: "read_thread", arguments: { thread_id: threadId, agent_session: session } })) as { content: { text: string }[] };
  return result.content.map((part) => part.text).join("\n");
}

const count = (text: string, part: string) => text.split(part).length - 1;
const WORDS = "Retry the webhook on a 409.\n\nIt is safe with the same key.";

describe("Board request", () => {
  test("with the chip on, the words are stored as typed and the delivered turn, Codex's queue and read_thread carry the block once", async () => {
    const { server, client, project } = await setup(true);
    await poll(server, "ses-a", project);
    const sent = await send(server, { body: WORDS, idempotency_key: "k1", board_request: true });
    expect(sent.message.body).toBe(WORDS);
    expect(sent.message.board_request).toBe(true);
    const block = inboxBoardRequestBlock(sent.message.thread_id);
    const stored = (await (await fetch(`${base(server)}/api/inbox/threads/${sent.message.thread_id}`)).json()) as { thread: InboxThread };
    expect(stored.thread.messages[0]!.body).toBe(WORDS);

    // A connection that polls again before it reports the delivery is handed the same turn: the block once each time.
    for (let round = 0; round < 2; round++) {
      const [command] = await poll(server, "ses-a", project);
      expect(command!.body).toBe(`${WORDS}\n\n${block}`);
      const wake = inboxWakeText(command!);
      expect(count(wake, INBOX_BOARD_REQUEST_OPEN)).toBe(1);
      // The markers stand on their own lines.
      expect(wake.split("\n")).toContain(INBOX_BOARD_REQUEST_OPEN);
      expect(count(codexQueueMessage(command!), INBOX_BOARD_REQUEST_OPEN)).toBe(1);
    }

    const text = await readThreadText(client, sent.message.thread_id);
    expect(count(text, INBOX_BOARD_REQUEST_OPEN)).toBe(1);
    expect(text).toContain(block);

    // A replayed Send answers the same message: nothing new, still one block.
    const replay = await send(server, { body: WORDS, idempotency_key: "k1", board_request: true });
    expect(replay).toMatchObject({ replayed: true, message: { id: sent.message.id } });
    expect(count(await readThreadText(client, sent.message.thread_id), INBOX_BOARD_REQUEST_OPEN)).toBe(1);
  });

  test("wait_for_reply hands the message sent with the chip with the block once in its text, and its JSON keeps the words", async () => {
    const { server, client, project } = await setup(true);
    await poll(server, "ses-a", project);
    const sent = await send(server, { body: WORDS, idempotency_key: "k1", board_request: true });
    const waited = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.message.thread_id, agent_session: "ses-a", timeout_seconds: 1 } })) as {
      content: { text: string }[];
      structuredContent: { reply: { body: string; board_request?: boolean } };
    };
    const first = waited.content.map((part) => part.text).join("\n");
    expect(first).toContain(WORDS);
    expect(count(first, INBOX_BOARD_REQUEST_OPEN)).toBe(1);
    // The JSON keeps the person's words and a flag, as read_thread's does: a client that prints both reads the block once.
    expect(waited.structuredContent.reply).toMatchObject({ body: WORDS, board_request: true });
  });

  test("of two turns handed in one poll, only the one sent with the chip carries the block", async () => {
    const { server, project } = await setup(true);
    await poll(server, "ses-a", project);
    const sent = await send(server, { body: WORDS, idempotency_key: "k1", board_request: true });
    expect((await post(server, `/api/inbox/messages/${sent.message.id}/reply`, { words: "And log each retry.", idempotency_key: "r1" })).status).toBe(200);
    const commands = await poll(server, "ses-a", project);
    expect(commands.map((c) => count(c.body, INBOX_BOARD_REQUEST_OPEN))).toEqual([1, 0]);
  });

  test("with the chip off, or the Board off, nothing is stored and the agent receives no block", async () => {
    for (const [board, flag] of [
      [true, undefined],
      [false, true],
    ] as const) {
      const { server, client, project } = await setup(board);
      await poll(server, "ses-a", project);
      const sent = await send(server, { body: WORDS, idempotency_key: "k1", ...(flag ? { board_request: flag } : {}) });
      expect(sent.message.board_request).toBeUndefined();
      const [command] = await poll(server, "ses-a", project);
      expect(command!.body).toBe(WORDS);
      expect(await readThreadText(client, sent.message.thread_id)).not.toContain(INBOX_BOARD_REQUEST_OPEN);
    }
  });

  test("a draft keeps the chip as it was left", async () => {
    const { server, project } = await setup(true);
    const id = inboxId("drf");
    const draftOf = async (body: Record<string, unknown>) => {
      const response = await post(server, `/api/inbox/drafts/${id}`, { body: "Track the retry work", to: null, project: { id: null, root: project, name: "billing" }, files: [], ...body });
      expect(response.status).toBe(200);
      return ((await response.json()) as { draft: InboxDraft }).draft;
    };
    const on = await draftOf({ base: null, board_request: true });
    expect(on.board_request).toBe(true);
    const listed = (await (await fetch(`${base(server)}/api/inbox/drafts`)).json()) as { drafts: InboxDraft[] };
    expect(listed.drafts.find((d) => d.id === id)?.board_request).toBe(true);
    const off = await draftOf({ base: on.updated_at });
    expect(off.board_request).toBeUndefined();
  });

  // Review of #2249: any session may read the thread again (after compaction, or one the thread moved to).
  // What regresses: a second reader told to create cards while one already links the thread.
  test.if(INBOX_CARD_ACTION_ON)("a second reader of the thread is told which card in flight already links it, so it makes no other; a shipped one is not named", async () => {
    const { server, client, project } = await setup(true);
    await poll(server, "ses-a", project);
    const sent = await send(server, { body: WORDS, idempotency_key: "k1", board_request: true });
    const threadId = sent.message.thread_id;
    expect(await readThreadText(client, threadId, "ses-b")).not.toContain("Already on the Board");
    const made = (await client.callTool({
      name: "card",
      arguments: { op: "create", title: "Fuzzy settings search", thread_id: threadId, project_path: project, agent_session: "ses-a", agent_host: "claude-code" },
    })) as { structuredContent: { card: { id: string } } };
    const cardId = made.structuredContent.card.id;
    const second = await readThreadText(client, threadId, "ses-b");
    expect(count(second, INBOX_BOARD_REQUEST_OPEN)).toBe(1);
    expect(second).toContain(`Already on the Board for this thread: ${cardId} (Fuzzy settings search)`);
    // Shipped, the card is done: new work in the thread gets a new card, so the line no longer names it.
    await client.callTool({ name: "card", arguments: { op: "ship", card_id: cardId, project_path: project, agent_session: "ses-a", agent_host: "claude-code" } });
    const after = await readThreadText(client, threadId, "ses-b");
    expect(count(after, INBOX_BOARD_REQUEST_OPEN)).toBe(1);
    expect(after).not.toContain("Already on the Board");
  });

  test("Codex's queue cuts a long message's words, never the block after them", async () => {
    const threadId = inboxId("msg");
    const long = "word ".repeat(Math.ceil(INBOX_CODEX_MESSAGE_MAX_BYTES / 5) + 100);
    const command: InboxReplyCommand = {
      type: "message",
      id: threadId,
      thread_id: threadId,
      reply_to: null,
      subject: "Long ask",
      body: `${long}\n\n${inboxBoardRequestBlock(threadId)}`,
      url: "http://127.0.0.1:1/#thread",
      new_thread: true,
    };
    const queued = codexQueueMessage(command);
    expect(Buffer.byteLength(queued)).toBeLessThanOrEqual(INBOX_CODEX_MESSAGE_MAX_BYTES);
    expect(queued).toContain("[Cut here:");
    expect(count(queued, inboxBoardRequestBlock(threadId))).toBe(1);
  });
});
