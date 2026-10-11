/**
 * Replying when the session that asked has ended (design record "replying
 * when the asking agent's session has ended", not in this repo), proved
 * through the server's real doors: the reply route's `to`, the connection's
 * poll and acknowledgement, the agent's MCP tools through the official SDK
 * client, and the sessions route's `asker`. Every test uses its own temp
 * data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_WAKE_INSTRUCTION,
  inboxRedirectedLine,
  inboxWakeText,
  parseInboxBridgeCommands,
} from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxAgentConnection, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxLiveSessions, INBOX_ASKER_GRACE_MS } from "./inbox-sessions";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-ended-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-ended-reply-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function agentSends(client: Client, project: string, session: string, body: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code" },
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

/** One poll from a connection working in the project: the session is live for 30 s after it. */
async function poll(server: InboxServer, session: string, project: string) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, host: "claude-code", project_path: project, waitMs: 0 });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

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

const QUESTION = ["I'm stopped on the retry policy.", "", ":::question", "How should the nightly sync retry?", "", "- [ ] Retry 3 times with backoff", "- [ ] Retry once", ":::"].join("\n");

describe("a reply to another session when the asking one has ended", () => {
  test("the reply goes only to the session picked: its poll gets it with the redirected line, the asker's does not, and another agent's read does not settle it", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-asker", QUESTION);
    await poll(server, "ses-taker", project);

    const response = await reply(server, asked.message_id, { idempotency_key: "k1", words: "Go with backoff.", to: { host: "claude-code", session: "ses-taker" } });
    expect(response.status).toBe(200);
    const sent = ((await response.json()) as { reply: { id: string; to: unknown; reply_to: string } }).reply;
    expect(sent.to).toEqual({ host: "claude-code", session: "ses-taker" });
    expect(sent.reply_to).toBe(asked.message_id);

    // The asking session (back with the same id) is not handed it.
    expect(await poll(server, "ses-asker", project)).toEqual([]);
    // Another agent reads the thread: it sees the reply, but that does not settle it.
    await client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-reader" } });
    expect((await thread(server, asked.thread_id)).messages.at(-1)?.body).toContain("Go with backoff.");
    const commands = await poll(server, "ses-taker", project);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "reply", id: sent.id, reply_to: asked.message_id, redirected_from: "Claude Code" });

    const lines = inboxWakeText(commands[0]!).split("\n");
    expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION);
    expect(lines[2]).toBe(inboxRedirectedLine("Claude Code", sent.id));
    expect(lines[2]).toBe(`This reply was written to another Claude Code session that has ended. Read the thread with read_thread to see what it asked, then answer with reply_to ${sent.id}.`);

    // Only the picked session may acknowledge it.
    const wrong = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-asker", host: "claude-code", type: "delivered", id: sent.id });
    expect(wrong.status).toBe(422);
    const right = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-taker", host: "claude-code", type: "delivered", id: sent.id });
    expect(right.status).toBe(200);
    expect((await thread(server, asked.thread_id)).messages.at(-1)?.delivery).toMatchObject({ host: "claude-code", session: "ses-taker" });
    expect(await poll(server, "ses-taker", project)).toEqual([]);
  });

  test("the asking session's wait_for_reply never returns a reply sent to another session; that session's own wait does, and records the delivery", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-asker", QUESTION);
    await poll(server, "ses-taker", project);
    expect((await reply(server, asked.message_id, { idempotency_key: "k1", words: "Retry once.", to: { session: "ses-taker" } })).status).toBe(200);

    const askerWait = await client.callTool({ name: "wait_for_reply", arguments: { thread_id: asked.thread_id, agent_session: "ses-asker", timeout_seconds: 1 } });
    expect((askerWait.structuredContent as { status: string }).status).toBe("waiting");
    const takerWait = await client.callTool({ name: "wait_for_reply", arguments: { thread_id: asked.thread_id, agent_session: "ses-taker", timeout_seconds: 1 } });
    expect(JSON.stringify(takerWait.content)).toContain("Retry once.");
    expect((await thread(server, asked.thread_id)).messages.at(-1)?.delivery).toMatchObject({ session: "ses-taker" });
  });

  test("a session that is not live is refused with 409 session_not_live and nothing is written; a replay of a reply that went answers what it wrote", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-asker", QUESTION);
    const before = await thread(server, asked.thread_id);
    const questionKey = before.messages[0]!.questions![0]!.key;

    // Never polled: not live.
    const refused = await reply(server, asked.message_id, {
      idempotency_key: "k-gone",
      words: "Go with backoff.",
      questions: [{ key: questionKey, revision: 0, answer: { v: 1, key: questionKey, kind: "single", prompt: "How should the nightly sync retry?", selected: ["Retry 3 times with backoff"] } }],
      to: { host: "claude-code", session: "ses-gone" },
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("session_not_live");
    const after = await thread(server, asked.thread_id);
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.messages[0]!.questions![0]).toMatchObject({ state: "open", answer: null });

    // A host that does not match the live session's is refused the same way.
    await poll(server, "ses-taker", project);
    const wrongHost = await reply(server, asked.message_id, { idempotency_key: "k-host", words: "x", to: { host: "pi", session: "ses-taker" } });
    expect(wrongHost.status).toBe(409);

    const sent = await reply(server, asked.message_id, { idempotency_key: "k-ok", words: "Go with backoff.", to: { host: "claude-code", session: "ses-taker" } });
    expect(sent.status).toBe(200);
    const first = ((await sent.json()) as { reply: { id: string } }).reply.id;
    // Replayed (a double press, or a retry after the taker went away): the same reply, nothing new.
    const again = await reply(server, asked.message_id, { idempotency_key: "k-ok", words: "Go with backoff.", to: { host: "claude-code", session: "ses-gone" } });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { reply: { id: string }; replayed: boolean })).toMatchObject({ replayed: true, reply: { id: first } });
    expect((await thread(server, asked.thread_id)).messages).toHaveLength(before.messages.length + 1);

    // A malformed `to` is a validation error, not a send.
    const bad = await reply(server, asked.message_id, { idempotency_key: "k-bad", words: "x", to: "ses-taker" });
    expect(bad.status).toBe(422);
  });

  test("a reply without `to` still goes to the asking session, and its wake carries no redirected line", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-asker", QUESTION);
    const response = await reply(server, asked.message_id, { idempotency_key: "k1", words: "Go with backoff." });
    expect(response.status).toBe(200);
    const commands = await poll(server, "ses-asker", project);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.redirected_from).toBeUndefined();
    expect(inboxWakeText(commands[0]!)).not.toContain("has ended");
  });

  test("the sessions route says whether the session that asked is still there", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-asker", QUESTION);
    await poll(server, "ses-asker", project);
    const model = (await (await fetch(`${base(server)}/api/inbox/threads/${asked.thread_id}/sessions?asker=ses-asker`)).json()) as { asker: unknown };
    expect(model.asker).toEqual({ session: "ses-asker", live: true });
    const plain = (await (await fetch(`${base(server)}/api/inbox/threads/${asked.thread_id}/sessions`)).json()) as { asker?: unknown };
    expect(plain.asker).toBeUndefined();
  });
});

describe("the Pi and OpenCode wake (agent-link) for a redirected reply", () => {
  test("the picked session's wake delivers the reply once, with the line saying the asker ended, and acknowledges it", async () => {
    const { server, client, project } = await setup();
    const dataDir = join(roots.at(-1)!, "data");
    const asked = await agentSends(client, project, "ses-asker", QUESTION);
    // A Pi session working in the project: it wrote there, and its wake polls.
    await client.callTool({ name: "send_message", arguments: { body: "On the export now.", project_path: project, agent_session: "ses-pi", agent_host: "pi", agent_name: "Pi" } });
    const connection = new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: [] });
    const delivered: { text: string; id: string }[] = [];
    const wake = new InboxWake(connection, "ses-pi", { isBusy: () => false, deliver: async (text, command) => void delivered.push({ text, id: command.id }), notify: () => {} }, 50);
    wake.start();
    try {
      const live = async () => ((await (await fetch(`${base(server)}/api/inbox/threads/${asked.thread_id}/sessions`)).json()) as { sessions: { session: string }[] }).sessions;
      for (let i = 0; i < 100 && !(await live()).some((s) => s.session === "ses-pi"); i++) await Bun.sleep(50);
      const response = await reply(server, asked.message_id, { idempotency_key: "k1", words: "Go with backoff.", to: { host: "pi", session: "ses-pi" } });
      expect(response.status).toBe(200);
      const sent = ((await response.json()) as { reply: { id: string; body: string } }).reply;
      for (let i = 0; i < 200 && delivered.length === 0; i++) await Bun.sleep(50);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.id).toBe(sent.id);
      const lines = delivered[0]!.text.split("\n");
      expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION);
      expect(lines[2]).toBe(inboxRedirectedLine("Claude Code", sent.id));
      expect(delivered[0]!.text.endsWith(`\n\n${sent.body}`)).toBe(true);
      let delivery: unknown = null;
      for (let i = 0; i < 100 && !delivery; i++) {
        delivery = (await thread(server, asked.thread_id)).messages.find((m) => m.id === sent.id)?.delivery ?? null;
        if (!delivery) await Bun.sleep(50);
      }
      expect(delivery).toMatchObject({ host: "pi", session: "ses-pi" });
      await Bun.sleep(300);
      expect(delivered).toHaveLength(1);
    } finally {
      wake.dispose();
    }
  });
});

describe("the asking session's grace", () => {
  test("a session is still there for the grace after its last poll; one never heard from reads as there only while the Inbox is younger than the grace", async () => {
    let now = 1_000_000;
    const live = createInboxLiveSessions({ store: {} as InboxStore, serverSession: "s", resolveRoot: async (path) => path, now: () => now });
    const done = await live.pollStarted("ses-a", "claude-code", {});
    done();
    expect(live.askerLive("ses-a")).toBe(true);
    expect(live.askerLive("ses-never")).toBe(true);
    now += INBOX_ASKER_GRACE_MS + 1;
    expect(live.askerLive("ses-a")).toBe(false);
    expect(live.askerLive("ses-never")).toBe(false);
    // Holding a poll open keeps it there however long the poll lasts.
    await live.pollStarted("ses-a", "claude-code", {});
    now += INBOX_ASKER_GRACE_MS * 3;
    expect(live.askerLive("ses-a")).toBe(true);
  });
});
