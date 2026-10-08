/**
 * The send tools' last sentence must match how the caller gets the answer.
 * The failure this guards: a connection whose wake delivers the person's reply
 * as a turn (the Claude Code mod, Pi, OpenCode 2) is told by send_message's
 * result to call wait_for_reply, contradicting the tool description, so the
 * model holds the session up to 50 s per call instead of ending its turn.
 * A caller without a wake (the stdio shim, a raw MCP client, OpenCode 1) must
 * keep the wait_for_reply advice.
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
import { startInboxServer, type InboxServer } from "./inbox";
import { GUIDE_BRIEF_EXAMPLE } from "./inbox-guides";

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

const WAITS = /wait_for_reply with this thread_id/;
const ARRIVES = /reply arrives in this session by itself/;

describe("the send tools' next step follows the caller's wake", () => {
  test("send_message through a connection whose wake runs: end the turn, never wait_for_reply", async () => {
    const { connection, project } = await setup();
    const result = await connection.callTool({ action: "send_message", body: "Which retry policy?" }, { sessionId: "ses_wakes", cwd: project, wakes: true });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(ARRIVES);
    expect(result.text).not.toMatch(WAITS);
  });

  test("send_message through a connection without a wake (OpenCode 1, an older connection): wait_for_reply", async () => {
    const { connection, project } = await setup();
    for (const at of [{ sessionId: "ses_a", cwd: project }, { sessionId: "ses_b", cwd: project, wakes: false }]) {
      const result = await connection.callTool({ action: "send_message", body: "Which retry policy?" }, at);
      expect(result.isError).toBe(false);
      expect(result.text).toMatch(WAITS);
      expect(result.text).not.toMatch(ARRIVES);
    }
  });

  test("a raw MCP client (the stdio shim's path): wait_for_reply", async () => {
    const { server, project } = await setup();
    const client = new Client({ name: "inbox-next-step-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    clients.push(client);
    const result = await client.callTool({ name: "send_message", arguments: { body: "Plain note", project_path: project, agent_session: "ses_shim" } });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(WAITS);
    expect(text).not.toMatch(ARRIVES);
  });

  test("submit_guide follows the same rule", async () => {
    const { connection, project } = await setup();
    const { body, guide, patch } = GUIDE_BRIEF_EXAMPLE;
    const woken = await connection.callTool({ action: "submit_guide", body, guide, patch, idempotency_key: "g-1" }, { sessionId: "ses_g", cwd: project, wakes: true });
    expect(woken.isError).toBe(false);
    expect(woken.text).toMatch(ARRIVES);
    expect(woken.text).not.toMatch(/wait_for_reply with this thread_id/);
    const waiting = await connection.callTool({ action: "submit_guide", body, guide, patch, idempotency_key: "g-2" }, { sessionId: "ses_h", cwd: project });
    expect(waiting.isError).toBe(false);
    expect(waiting.text).toMatch(/wait_for_reply with this thread_id/);
  });
});
