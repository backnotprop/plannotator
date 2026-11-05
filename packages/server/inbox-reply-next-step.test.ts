/**
 * The send tools' last sentence must match how the caller gets the answer.
 * The failures this guards: a connection whose wake delivers the person's
 * reply as a turn (the Claude Code mod, Pi, OpenCode 2) is told by
 * send_message's result to read the thread, so the model polls instead of
 * ending its turn; a caller without a wake (the stdio shim, a raw MCP client,
 * OpenCode 1) is told to wait for a reply that never comes to it, or to call
 * the removed wait_for_reply, instead of to read the thread later.
 *
 * Proved against a real Inbox on loopback with the real connection code
 * (`InboxAgentConnection`, which Pi and OpenCode use) and the official MCP
 * SDK client. Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { discoverInboxTools, InboxAgentConnection } from "@plannotator/shared/inbox/agent-link";
import { INBOX_REMOVED_ACTION_TEXT } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { GUIDE_BRIEF_EXAMPLE } from "./inbox-guides";
import { INBOX_REPLY_LOOK_TEXT } from "./inbox-mcp";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<{ server: InboxServer; connection: InboxAgentConnection; project: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-next-step-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const tools = await discoverInboxTools(dataDir);
  expect(tools).not.toBeNull();
  // `command` is never run: the Inbox above is running, so the call never starts one.
  const connection = new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: tools!, command: "/nonexistent/plannotator" });
  return { server, connection, project };
}

const READ_LATER = /call read_thread with this thread_id later/;
const ARRIVES = /reply arrives in this session by itself/;

describe("the send tools' next step follows the caller's wake", () => {
  test("send_message through a connection whose wake runs: end the turn, never read the thread", async () => {
    const { connection, project } = await setup();
    const result = await connection.callTool({ action: "send_message", body: "Which retry policy?" }, { sessionId: "ses_wakes", cwd: project, wakes: true });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(ARRIVES);
    expect(result.text).not.toMatch(READ_LATER);
    // A connection hands a reply until it is delivered: only Codex and Qwen, woken once, are told to look.
    expect(result.text).not.toContain(INBOX_REPLY_LOOK_TEXT);
  });

  test("send_message through a connection without a wake (OpenCode 1, an older connection): read the thread later, no wait", async () => {
    const { connection, project } = await setup();
    for (const at of [{ sessionId: "ses_a", cwd: project }, { sessionId: "ses_b", cwd: project, wakes: false }]) {
      const result = await connection.callTool({ action: "send_message", body: "Which retry policy?" }, at);
      expect(result.isError).toBe(false);
      expect(result.text).toMatch(READ_LATER);
      expect(result.text).not.toMatch(ARRIVES);
      expect(result.text).not.toContain("wait_for_reply");
    }
  });

  test("a raw MCP client (the stdio shim's path): read the thread later, no wait", async () => {
    const { server, project } = await setup();
    const client = new Client({ name: "inbox-next-step-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    clients.push(client);
    const result = await client.callTool({ name: "send_message", arguments: { body: "Plain note", project_path: project, agent_session: "ses_shim" } });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(READ_LATER);
    // It says plainly that nothing wakes it, not only what to call.
    expect(text).toMatch(/reply won't arrive in this session by itself/);
    expect(text).not.toMatch(ARRIVES);
    expect(text).not.toContain("wait_for_reply");
  });

  test("submit_guide follows the same rule", async () => {
    const { connection, project } = await setup();
    const { body, guide, patch } = GUIDE_BRIEF_EXAMPLE;
    const woken = await connection.callTool({ action: "submit_guide", body, guide, patch, idempotency_key: "g-1" }, { sessionId: "ses_g", cwd: project, wakes: true });
    expect(woken.isError).toBe(false);
    expect(woken.text).toMatch(ARRIVES);
    expect(woken.text).not.toMatch(READ_LATER);
    const later = await connection.callTool({ action: "submit_guide", body, guide, patch, idempotency_key: "g-2" }, { sessionId: "ses_h", cwd: project });
    expect(later.isError).toBe(false);
    expect(later.text).toMatch(READ_LATER);
  });
});

describe("the removed wait_for_reply, as an older plugin, skill or raw client still calls it", () => {
  test("/mcp answers a tool error saying what to do, not a crash; nothing is written, and the call still counts as the session being there", async () => {
    const { server, project } = await setup();
    const client = new Client({ name: "inbox-old-wait-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    clients.push(client);
    const sent = (await client.callTool({ name: "send_message", arguments: { body: "Plain note", project_path: project, agent_session: "ses_old" } })).structuredContent as { thread_id: string };
    const before = server.store.cursor();
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("wait_for_reply");

    const old = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.thread_id, timeout_seconds: 50, agent_session: "ses_old" } })) as { isError?: boolean; content: { text: string }[] };
    expect(old.isError).toBe(true);
    expect(old.content).toEqual([{ type: "text", text: INBOX_REMOVED_ACTION_TEXT }]);
    expect(old.content[0]!.text).toContain("read_thread");
    expect(server.store.cursor()).toBe(before);
  });

  test("the refused call still counts as the session being there: a session known only by it can be tagged", async () => {
    const { server, project } = await setup();
    const client = new Client({ name: "inbox-old-wait-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    clients.push(client);
    const sent = (await client.callTool({ name: "send_message", arguments: { body: "Plain note", project_path: project, agent_session: "ses_asker" } })).structuredContent as { message_id: string; thread_id: string };
    const tag = (key: string) =>
      fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${sent.message_id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: key, words: "See this.", tags: [{ session: "ses_only_old" }] }),
      });
    expect((await tag("k1")).status).toBeGreaterThanOrEqual(400);
    const old = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.thread_id, agent_session: "ses_only_old", agent_host: "codex", agent_name: "Codex" } })) as { isError?: boolean };
    expect(old.isError).toBe(true);
    expect((await tag("k2")).status).toBe(200);
  });

  test("a body of several calls gets the MCP server's own answer, not a crash", async () => {
    const { server } = await setup();
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_reply", arguments: {} } }]),
    });
    expect(response.status).toBeLessThan(500);
  });
});
