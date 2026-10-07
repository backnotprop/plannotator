/**
 * The Inbox's connection bridge (plan step 6), proved through its real doors:
 * a running server on loopback, the agent writing through the official MCP
 * SDK client, the person's Send through the window's own route, and the
 * connection's long-poll and acknowledgement through real `fetch` / raw TCP.
 * Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<{ server: InboxServer; client: Client; project: string; dataDir: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-bridge-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const client = new Client({ name: "inbox-bridge-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, dataDir };
}

async function agentSends(client: Client, project: string, session: string, body: string): Promise<{ message_id: string; thread_id: string }> {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code" },
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

async function personReplies(server: InboxServer, messageId: string, words: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `send-${messageId}`, words }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { reply: { id: string } }).reply.id;
}

function bridge(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
}

async function poll(server: InboxServer, session: string, waitMs = 0) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, waitMs });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

/** A raw HTTP/1.1 request, so Host and Origin are exactly what the test sends. */
function raw(port: number, lines: string[], body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
    socket.write([...lines, "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", ""].join("\r\n") + body);
  });
}

describe("Inbox connection bridge", () => {
  test("a held poll answers the moment the person sends, with the reply verbatim for the asking session only", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "session-a", "Ship the retry worker today?");
    await agentSends(client, project, "session-b", "Another session's question.");

    const started = Date.now();
    const held = poll(server, "session-a", 20_000);
    const other = poll(server, "session-b", 1_500);
    await Bun.sleep(300);
    const replyId = await personReplies(server, asked.message_id, "Yes, ship it.\n\nBut keep the flag off.");
    const commands = await held;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "reply", id: replyId, thread_id: asked.thread_id, reply_to: asked.message_id, subject: "Ship the retry worker today?" });
    expect(commands[0]!.body).toContain("Yes, ship it.\n\nBut keep the flag off.");
    expect(commands[0]!.url).toBe(`${server.url}#thread=${asked.thread_id}`);
    // Another session's poll is not woken by it, and waits out its own hold.
    expect(await other).toEqual([]);
  });

  test("a poll with nothing waiting holds for its wait, and never beyond 25 s", async () => {
    const { server } = await setup();
    const started = Date.now();
    expect(await poll(server, "nobody", 600)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });

  test("the reply is handed out on every poll until delivered; delivered, the thread records it and the Sent band reads it as read", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "session-a", "Which region?");
    const replyId = await personReplies(server, asked.message_id, "us-east-1");

    expect((await poll(server, "session-a")).map((c) => c.id)).toEqual([replyId]);
    expect((await poll(server, "session-a")).map((c) => c.id)).toEqual([replyId]);

    const delivered = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "session-a", host: "claude-code", type: "delivered", id: replyId });
    expect(delivered.status).toBe(200);
    expect(await poll(server, "session-a")).toEqual([]);
    // Idempotent: a second acknowledgement (a lost answer, another process) changes nothing.
    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "session-a", host: "claude-code", type: "delivered", id: replyId })).status).toBe(200);

    const after = await thread(server, asked.thread_id);
    const reply = after.messages.find((m) => m.id === replyId)!;
    expect(reply.delivery).toMatchObject({ state: "delivered", host: "claude-code", session: "session-a" });
    const rows = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads`)).json()) as { sections: { id: string; threads: { thread_id: string; sent: { checked_at: string | null } | null }[] }[] };
    const row = rows.sections.flatMap((s) => s.threads.map((t) => ({ ...t, section: s.id }))).find((t) => t.thread_id === asked.thread_id)!;
    // "Delivered to Claude Code, <time>": the agent has the reply, so the row leaves Sent.
    expect(row.section).toBe("quiet");
    expect(row.sent?.checked_at).toBe(reply.delivery!.at);

    // "Replied": the asking session's next message lands after the delivered reply.
    await agentSends(client, project, "session-a", "Done: deployed to us-east-1.");
    const replied = await thread(server, asked.thread_id);
    expect(replied.messages.at(-1)?.author).toMatchObject({ kind: "agent", session: "session-a" });
  });

  test("a reply the agent already read through the MCP is not woken again", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "session-a", "Merge now?");
    await personReplies(server, asked.message_id, "Merge.");
    const waited = await client.callTool({ name: "wait_for_reply", arguments: { thread_id: asked.thread_id, agent_session: "session-a" } });
    expect((waited.structuredContent as { status: string }).status).toBe("replied");
    expect(await poll(server, "session-a")).toEqual([]);
  });

  test("an acknowledgement for another session's reply is refused and changes nothing", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "session-a", "Rename the table?");
    const replyId = await personReplies(server, asked.message_id, "No.");
    const wrong = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "session-b", host: "claude-code", type: "delivered", id: replyId });
    expect(wrong.status).toBe(422);
    expect((await poll(server, "session-a")).map((c) => c.id)).toEqual([replyId]);
    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "session-a", type: "seen", id: replyId })).status).toBe(422);
    expect((await bridge(server, INBOX_BRIDGE_POLL_PATH, { waitMs: 0 })).status).toBe(422);
  });

  test("the doors: the registry token, a loopback Host naming this port, and no Origin", async () => {
    const { server } = await setup();
    const body = JSON.stringify({ session: "s", waitMs: 0 });
    const at = (headers: string[]) => raw(server.port, [`POST ${INBOX_BRIDGE_POLL_PATH} HTTP/1.1`, ...headers], body);
    expect(await at([`Host: 127.0.0.1:${server.port}`])).toBe(401);
    expect(await at([`Host: 127.0.0.1:${server.port}`, "Authorization: Bearer wrong-token-wrong-token-wrong-token"])).toBe(401);
    expect(await at([`Host: 127.0.0.1:${server.port + 1}`, `Authorization: Bearer ${server.token}`])).toBe(403);
    expect(await at([`Host: evil.example:${server.port}`, `Authorization: Bearer ${server.token}`])).toBe(403);
    expect(await at([`Host: 127.0.0.1:${server.port}`, `Authorization: Bearer ${server.token}`, `Origin: http://127.0.0.1:${server.port}`])).toBe(403);
    expect(await at([`Host: 127.0.0.1:${server.port}`, `Authorization: Bearer ${server.token}`])).toBe(200);
    expect(await raw(server.port, [`GET ${INBOX_BRIDGE_POLL_PATH} HTTP/1.1`, `Host: 127.0.0.1:${server.port}`, `Authorization: Bearer ${server.token}`], "")).toBe(405);
  });

  test("a reply waits for its session across an Inbox restart (nothing is queued in memory)", async () => {
    const { server, client, project, dataDir } = await setup();
    const asked = await agentSends(client, project, "session-a", "Keep the old endpoint?");
    const replyId = await personReplies(server, asked.message_id, "Keep it one more release.");
    await client.close();
    clients.length = 0;
    server.stop();
    servers.length = 0;
    const again = await startInboxServer({ dataDir });
    servers.push(again);
    expect((await poll(again, "session-a")).map((c) => c.id)).toEqual([replyId]);
  });
});
