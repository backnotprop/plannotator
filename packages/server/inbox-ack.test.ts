/**
 * 👍 Looks good (design record "inbox-acknowledge", approved 2026-10-15,
 * amended 2026-10-16: it reaches the agent) through the Inbox's real doors:
 * `POST /api/inbox/messages/:id/ack` on a running Inbox (temp data dir,
 * loopback), the agent side over the official MCP client, the wake over the
 * bridge. Inside the Undo window (shortened here) nothing is sent; after it
 * the 👍 is delivered once as a wake turn to a connection's session, and
 * read_thread shows it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection, InboxMessageWire } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, inboxAckLine, inboxWakeText, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { InboxAgentConnection, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DELAY = 150;
const SESSION = "ses_ack";

const QUESTION = [
  "One thing first:",
  "",
  ":::question",
  "Ship it today?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

async function setup(body = "Merged #1937. CI is green on main. Nothing needs you here.") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-ack-")));
  roots.push(root);
  const project = join(root, "plannotator");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), setAsideDelayMs: DELAY });
  servers.push(server);
  const client = new Client({ name: "inbox-ack-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (text: string, replyTo?: string) =>
    (
      (await client.callTool({
        name: "send_message",
        arguments: { project_path: project, agent_session: SESSION, agent_name: "Claude Code", agent_host: "claude-code", body: text, ...(replyTo ? { reply_to: replyTo } : {}) },
      })) as { structuredContent: { thread_id: string; message_id: string } }
    ).structuredContent;
  const sent = await send(body);
  return { server, client, send, threadId: sent.thread_id, messageId: sent.message_id };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const ack = (server: InboxServer, messageId: string, on = true, extra: Record<string, unknown> = {}) =>
  post(server, `/api/inbox/messages/${messageId}/ack`, { serverSession: server.serverSession, ...(on ? {} : { ack: false }), ...extra });

async function rowOf(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const model = (await (await fetch(url(server, "/api/inbox/threads"))).json()) as { sections: InboxListSection[] };
  return model.sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
}

async function windowMessage(server: InboxServer, threadId: string, messageId: string): Promise<InboxMessageWire> {
  const model = (await (await fetch(url(server, `/api/inbox/threads/${threadId}`))).json()) as { thread: { messages: InboxMessageWire[] } };
  return model.thread.messages.find((m) => m.id === messageId)!;
}

async function readThread(client: Client, threadId: string) {
  return (await client.callTool({ name: "read_thread", arguments: { thread_id: threadId } })) as {
    structuredContent: { thread: { messages: (InboxMessageWire & { ack?: unknown })[] } };
  };
}

async function poll(server: InboxServer, session: string, waitMs = 0) {
  const response = await fetch(url(server, INBOX_BRIDGE_POLL_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, waitMs }),
  });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

async function delivered(server: InboxServer, session: string, id: string) {
  return fetch(url(server, INBOX_BRIDGE_EVENT_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", type: "delivered", id }),
  });
}

describe("POST /api/inbox/messages/:id/ack", () => {
  test("records the ack on the agent's message, marks the thread read, and the row says Looks good; Undo takes both back", async () => {
    const { server, threadId, messageId } = await setup();
    expect((await rowOf(server, threadId)).section).toBe("new");
    const res = await ack(server, messageId);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { message: InboxMessageWire; thread: InboxListRow };
    expect(answer.message.ack).toMatchObject({ label: "Looks good", settled_seq: null, seen_at: null });
    expect(answer.thread.section).toBe("quiet");
    expect(answer.thread.read_at).not.toBeNull();
    expect(answer.thread.ack).toMatchObject({ label: "Looks good" });
    // Inside the Undo window nothing is written for the agent.
    expect(server.store.thread(threadId)!.messages).toHaveLength(1);
    expect(server.store.pendingReplies(SESSION)).toEqual([]);
    expect((await windowMessage(server, threadId, messageId)).ack).toMatchObject({ label: "Looks good" });

    const back = await ack(server, messageId, false);
    expect(back.status).toBe(200);
    const undone = (await back.json()) as { message: InboxMessageWire; thread: InboxListRow };
    expect(undone.message.ack).toBeNull();
    expect(undone.thread.read_at ?? null).toBeNull();
    expect(undone.thread.ack ?? null).toBeNull();
    expect(undone.thread.section).toBe("new");
  });

  test("a second 👍 changes nothing; an agent's next message ends the read and the row's Looks good", async () => {
    const { server, threadId, messageId, send } = await setup();
    await ack(server, messageId);
    const lines = server.store.cursor();
    expect((await ack(server, messageId)).status).toBe(200);
    expect(server.store.cursor()).toBe(lines);
    await send("Next I'm looking at the stepping bug.", messageId);
    const row = await rowOf(server, threadId);
    expect(row.section).toBe("new");
    expect(row.ack ?? null).toBeNull();
    // The ack stays on the older message as history.
    expect((await windowMessage(server, threadId, messageId)).ack).toMatchObject({ label: "Looks good" });
  });

  test("refusals: a question open or picked, an older agent message, a person's message, an archived thread, the guards", async () => {
    const asking = await setup(QUESTION);
    const open = await ack(asking.server, asking.messageId);
    expect(open.status).toBe(409);
    expect(((await open.json()) as { code: string }).code).toBe("question_open");

    const { server, threadId, messageId, send } = await setup();
    const later = await send("One more update.", messageId);
    const stale = await ack(server, messageId);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("ack_stale");

    const replied = await post(server, `/api/inbox/messages/${later.message_id}/reply`, { idempotency_key: "r1", words: "cool" });
    const replyId = ((await replied.json()) as { reply: { id: string } }).reply.id;
    const person = await ack(server, replyId);
    expect(person.status).toBe(422);
    expect(((await person.json()) as { code: string }).code).toBe("ack_not_allowed");
    // The person already replied after the agent's latest message: the reply is the answer, and the row stays Sent.
    const afterReply = await ack(server, later.message_id);
    expect(afterReply.status).toBe(409);
    expect(((await afterReply.json()) as { code: string }).code).toBe("ack_after_reply");
    expect((await rowOf(server, threadId)).section).toBe("sent");

    expect((await post(server, `/api/inbox/messages/${later.message_id}/ack`,{}, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await ack(server, later.message_id, true, { serverSession: "an-older-inbox" })).status).toBe(409);
    expect((await fetch(url(server, `/api/inbox/messages/${later.message_id}/ack`))).status).toBe(405);
    expect((await ack(server, later.message_id, true, { ack: "yes" })).status).toBe(422);
    expect((await ack(server, "msg_00000000000000000000000000")).status).toBe(404);

    await post(server, `/api/inbox/messages/${threadId}/resolve`, { resolved: true });
    const archived = await ack(server, later.message_id);
    expect(archived.status).toBe(409);
    expect(((await archived.json()) as { code: string }).code).toBe("thread_resolved");
  });

  test("Move back on the thread withdraws the 👍 too: the agent never sees it", async () => {
    const { server, client, threadId, messageId } = await setup();
    await ack(server, messageId);
    const back = await post(server, `/api/inbox/threads/${threadId}/unread`, { serverSession: server.serverSession });
    expect(back.status).toBe(200);
    expect((await windowMessage(server, threadId, messageId)).ack).toBeNull();
    const row = await rowOf(server, threadId);
    expect(row.read_at ?? null).toBeNull();
    expect(row.ack ?? null).toBeNull();
    await Bun.sleep(DELAY + 400);
    expect((await readThread(client, threadId)).structuredContent.thread.messages[0]!.ack ?? null).toBeNull();
  });

  test("an already-read thread stays read when the 👍 is taken back", async () => {
    const { server, threadId, messageId } = await setup();
    await post(server, `/api/inbox/threads/${threadId}/read`, {});
    await ack(server, messageId);
    await ack(server, messageId, false);
    const row = await rowOf(server, threadId);
    expect(row.read_at).not.toBeNull();
    expect(row.ack ?? null).toBeNull();
  });
});

describe("what the agent sees", () => {
  test("read_thread carries the ack only after the Undo window, and reading it marks it seen", async () => {
    const { server, client, threadId, messageId } = await setup();
    await ack(server, messageId);
    // Inside the window: not there yet, in the thread or in the list of threads.
    expect((await readThread(client, threadId)).structuredContent.thread.messages[0]!.ack ?? null).toBeNull();
    const listed = (await client.callTool({ name: "read_thread", arguments: { project_path: server.store.project(server.store.message(threadId)!.project_id)!.root, agent_session: SESSION } })) as {
      structuredContent: { threads: Record<string, unknown>[] };
    };
    expect(listed.structuredContent.threads.map((t) => t.thread_id)).toEqual([threadId]);
    expect(listed.structuredContent.threads[0]!).not.toHaveProperty("ack");
    await Bun.sleep(DELAY + 400);
    const read = (await readThread(client, threadId)).structuredContent.thread.messages[0]!;
    expect(read.ack).toEqual({ label: "Looks good", at: expect.any(String) });
    const seen = (await windowMessage(server, threadId, messageId)).ack!;
    expect(seen.seen_at).toEqual(expect.any(String));
    expect(seen.settled_seq).toEqual(expect.any(Number));
  });

  test("an Undo inside the window: read_thread never sees it", async () => {
    const { server, client, threadId, messageId } = await setup();
    await ack(server, messageId);
    await ack(server, messageId, false);
    await Bun.sleep(DELAY + 400);
    expect((await readThread(client, threadId)).structuredContent.thread.messages[0]!.ack ?? null).toBeNull();
  });

  test("the wake: nothing inside the window, then one turn naming the message, delivered once", async () => {
    const { server, client, threadId, messageId } = await setup();
    await ack(server, messageId);
    expect(await poll(server, SESSION)).toEqual([]);
    await Bun.sleep(DELAY + 400);
    const commands = await poll(server, SESSION);
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command).toMatchObject({ type: "reply", thread_id: threadId, reply_to: messageId, ack_of: messageId });
    expect(command.body).toBe(`The person marked your message 👍 Looks good (${messageId}). No reply needed unless you have a question.`);
    expect(inboxWakeText(command)).toBe(
      `Plannotator Inbox: ${command.subject} (${command.id})\nThe person marked your message 👍 Looks good (${messageId}). No reply needed unless you have a question.\n\n[thread ${threadId}]`,
    );
    // Another session is never handed it.
    expect(await poll(server, "ses_other")).toEqual([]);
    // Before delivery the window's line has no delivery yet.
    expect((await windowMessage(server, threadId, messageId)).ack!.delivered_at ?? null).toBeNull();
    expect((await delivered(server, SESSION, command.id)).status).toBe(200);
    expect((await delivered(server, SESSION, command.id)).status).toBe(200);
    expect(await poll(server, SESSION)).toEqual([]);
    expect((await windowMessage(server, threadId, messageId)).ack!.delivered_at).toEqual(expect.any(String));
    // The note is not a message of the thread, for the window or for read_thread; the row stays Quiet with the 👍.
    expect(server.store.windowThread(threadId)!.messages.map((m) => m.id)).toEqual([messageId]);
    expect((await readThread(client, threadId)).structuredContent.thread.messages.map((m) => m.id)).toEqual([messageId]);
    const row = await rowOf(server, threadId);
    expect(row.section).toBe("quiet");
    expect(row.message_count).toBe(1);
    expect(row.ack).toMatchObject({ label: "Looks good" });
  });

  test("a held bridge poll wakes when the window passes", async () => {
    const { server, messageId } = await setup();
    const held = poll(server, SESSION, 5_000);
    await Bun.sleep(30);
    const started = Date.now();
    await ack(server, messageId);
    const commands = await held;
    expect(commands.map((c) => c.ack_of)).toEqual([messageId]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("taken back before it went: an Undo inside the window, or the pressed button before delivery, sends nothing", async () => {
    const inside = await setup();
    await ack(inside.server, inside.messageId);
    await ack(inside.server, inside.messageId, false);
    await Bun.sleep(DELAY + 400);
    expect(await poll(inside.server, SESSION)).toEqual([]);

    const after = await setup();
    await ack(after.server, after.messageId);
    await Bun.sleep(DELAY + 400);
    expect(await poll(after.server, SESSION)).toHaveLength(1);
    await ack(after.server, after.messageId, false);
    expect(await poll(after.server, SESSION)).toEqual([]);
    // A new 👍 later is sent again, once.
    await ack(after.server, after.messageId);
    await Bun.sleep(DELAY + 400);
    expect(await poll(after.server, SESSION)).toHaveLength(1);
  });

  test("an agent that is not woken reads the 👍: read_thread counts as the delivery, and the wake never hands it again", async () => {
    const { server, client, threadId, messageId } = await setup();
    await ack(server, messageId);
    await Bun.sleep(DELAY + 400);
    await readThread(client, threadId);
    expect(await poll(server, SESSION)).toEqual([]);
    expect((await windowMessage(server, threadId, messageId)).ack!.delivered_at).toEqual(expect.any(String));
  });

  test("replay: a restart keeps the 👍 delivered once; nothing is handed out again", async () => {
    const { server, threadId, messageId } = await setup();
    await ack(server, messageId);
    await Bun.sleep(DELAY + 400);
    const [command] = await poll(server, SESSION);
    await delivered(server, SESSION, command!.id);
    const dataDir = join(server.store.dir, "..");
    const before = server.store.windowThread(threadId);
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const next = await startInboxServer({ dataDir, setAsideDelayMs: DELAY });
    servers.push(next);
    await Bun.sleep(DELAY + 200);
    expect(next.store.pendingReplies(SESSION)).toEqual([]);
    expect(next.store.windowThread(threadId)).toEqual(before);
  });

  test("an ack a stop interrupted inside its window is settled at the next start", async () => {
    const { server, threadId, messageId } = await setup();
    await ack(server, messageId);
    const dataDir = join(server.store.dir, "..");
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    await Bun.sleep(DELAY + 100);
    const next = await startInboxServer({ dataDir, setAsideDelayMs: DELAY });
    servers.push(next);
    await Bun.sleep(100);
    expect(next.store.message(messageId)!.ack!.settled_seq).toEqual(expect.any(Number));
    expect(next.store.thread(threadId)!.messages).toHaveLength(1);
    // Settled at the start, it is sent then: one command for the session.
    expect(next.store.pendingReplies(SESSION).map((m) => m.ack_of)).toEqual([messageId]);
  });
});

describe("a 👍 the window ends after the thread moved on", () => {
  test("the person replied inside the window: the agent gets the reply, never the 👍; the window says not sent", async () => {
    const { server, client, threadId, messageId } = await setup();
    await ack(server, messageId);
    const replied = await post(server, `/api/inbox/messages/${messageId}/reply`, { serverSession: server.serverSession, idempotency_key: "r-in-window", words: "Wait, also bump the version." });
    expect(replied.status).toBe(200);
    const replyId = ((await replied.json()) as { reply: { id: string } }).reply.id;
    await Bun.sleep(DELAY + 400);
    expect((await poll(server, SESSION)).map((c) => [c.id, c.ack_of ?? null])).toEqual([[replyId, null]]);
    expect((await windowMessage(server, threadId, messageId)).ack).toMatchObject({ not_sent: "replied", delivered_at: null });
    expect((await readThread(client, threadId)).structuredContent.thread.messages[0]!.ack ?? null).toBeNull();
  });

  test("the agent wrote again inside the window: the 👍 is not sent for the older message, and read_thread does not show it", async () => {
    const { server, client, threadId, messageId, send } = await setup();
    await ack(server, messageId);
    await send(QUESTION, messageId);
    await Bun.sleep(DELAY + 400);
    expect(await poll(server, SESSION)).toEqual([]);
    expect((await windowMessage(server, threadId, messageId)).ack).toMatchObject({ not_sent: "wrote_again", delivered_at: null });
    expect((await readThread(client, threadId)).structuredContent.thread.messages[0]!.ack ?? null).toBeNull();
  });
});

describe("the Pi and OpenCode wake (agent-link)", () => {
  for (const host of [
    { id: "pi", name: "Pi" },
    { id: "opencode", name: "OpenCode" },
  ]) {
    test(`${host.name}: the 👍 is delivered once as a turn after the Undo window, and acknowledged`, async () => {
      const { server, client } = await setup();
      const dataDir = join(roots.at(-1)!, "data");
      const project = join(roots.at(-1)!, "plannotator");
      const session = `ses-${host.id}`;
      const sent = (
        (await client.callTool({
          name: "send_message",
          arguments: { project_path: project, agent_session: session, agent_name: host.name, agent_host: host.id, body: "Release notes drafted; nothing needs you." },
        })) as { structuredContent: { message_id: string; thread_id: string } }
      ).structuredContent;
      const connection = new InboxAgentConnection({ dataDir, host: host.id, agentName: host.name, tools: [] });
      const delivered: { text: string; id: string }[] = [];
      const wake = new InboxWake(connection, session, { isBusy: () => false, deliver: async (text, command) => void delivered.push({ text, id: command.id }), notify: () => {} }, 50);
      wake.start();
      try {
        await ack(server, sent.message_id);
        await Bun.sleep(DELAY / 2);
        expect(delivered).toEqual([]);
        for (let i = 0; i < 200 && delivered.length === 0; i++) await Bun.sleep(50);
        expect(delivered).toHaveLength(1);
        const subject = server.store.threadSubject(sent.thread_id);
        expect(delivered[0]!.text).toBe(`Plannotator Inbox: ${subject} (${delivered[0]!.id})\n${inboxAckLine(sent.message_id)}\n\n[thread ${sent.thread_id}]`);
        let shown: string | null = null;
        for (let i = 0; i < 100 && !shown; i++) {
          shown = (await windowMessage(server, sent.thread_id, sent.message_id)).ack?.delivered_at ?? null;
          if (!shown) await Bun.sleep(50);
        }
        expect(shown).toEqual(expect.any(String));
        expect(server.store.message(delivered[0]!.id)!.delivery).toMatchObject({ host: host.id, session });
        await Bun.sleep(300);
        expect(delivered).toHaveLength(1);
      } finally {
        wake.dispose();
      }
    });
  }
});
