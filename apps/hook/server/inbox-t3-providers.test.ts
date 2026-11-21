/**
 * T3 Code Inbox wake across all providers that inject `T3CODE_THREAD_ID`:
 * Claude, Codex, Pi, and ACP agents. Runs in-process (`runInboxMcpShim` +
 * `startInboxServer` + `startFakeT3`) so it executes cleanly on every OS.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { INBOX_REPLY_ARRIVES_TEXT, INBOX_REPLY_READ_LATER_TEXT } from "@plannotator/server/inbox-mcp";
import { T3Credentials } from "@plannotator/t3-code/auth";
import { T3_CLI_USAGE } from "@plannotator/t3-code/usage";
import { type FakeT3, startFakeT3 } from "../../../tests/helpers/fake-t3";
import {
  fillInboxToolArguments,
  inboxCallHostSession,
  inboxClaudeCallSession,
  inboxClaudeMcpSessionFromEnv,
  inboxHostSessionFromEnv,
  inboxT3EntryIdle,
  runInboxMcpShim,
} from "./inbox-mcp-shim";

const THREAD = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const CODEX_THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const CLAUDE_SESSION = "0f3c2a51-7d4e-4b8a-9e21-5c6d7e8f9a0b";
const QWEN_SESSION = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a99";

const roots: string[] = [];
const servers: InboxServer[] = [];
const fakes: FakeT3[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const fake of fakes.splice(0)) fake.stop();
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold a temp handle after server.stop().
    }
  }
});

function scratch(): { root: string; dataDir: string; project: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-t3-providers-")));
  roots.push(root);
  return { root, dataDir: join(root, "data"), project: root };
}

type RpcReply = {
  id: number;
  result?: {
    content?: { text: string }[];
    structuredContent?: { message_id: string; thread_id: string };
  };
  error?: { message: string };
};

async function runShimCall(options: {
  dataDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  clientInfo: { name: string; version: string };
  toolArgs: Record<string, unknown>;
  meta?: Record<string, unknown>;
}): Promise<RpcReply> {
  const lines: string[] = [];
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: options.clientInfo },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: options.toolArgs,
        ...(options.meta ? { _meta: options.meta } : {}),
      },
    },
  ];
  await runInboxMcpShim({
    dataDir: options.dataDir,
    cwd: options.cwd,
    ensureRunning: async () => {
      throw new Error("Inbox server should already be running in test");
    },
    hostSession: inboxHostSessionFromEnv(options.env),
    claude: inboxClaudeMcpSessionFromEnv(options.env),
    qwen: options.env.QWEN_CODE_SESSION_ID ? { home: join(options.cwd, ".qwen"), parentPid: 999999, envSession: options.env.QWEN_CODE_SESSION_ID } : null,
    t3EntryIdle: inboxT3EntryIdle(true, options.env),
    input: new Blob([messages.map((m) => `${JSON.stringify(m)}\n`).join("")]).stream(),
    write: (line) => lines.push(line),
  });
  const replies = lines.map((line) => JSON.parse(line) as RpcReply);
  const callReply = replies.find((r) => r.id === 2);
  if (!callReply) throw new Error(`Missing tools/call reply: ${lines.join("\n")}`);
  return callReply;
}

describe("T3 Code provider routing in the Inbox MCP shim", () => {
  test("T3 thread identity wins over Codex _meta, Claude MCP session, and Qwen-over-ACP when T3CODE_THREAD_ID is set", () => {
    const t3 = { host: "t3", session: THREAD, name: "T3 Code" };
    const asThread = { body: "hi", project_path: "/work", agent_session: THREAD, agent_host: "t3", agent_name: "T3 Code" };

    // Codex in T3: _meta.threadId and codex-mcp-client do not overwrite hostSession=t3.
    expect(
      fillInboxToolArguments(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "send_message",
            arguments: { body: "hi", agent_host: "codex" },
            _meta: { threadId: CODEX_THREAD, "x-codex-turn-metadata": { turn_trigger: "user" } },
          },
        },
        "/work",
        "ses_OWN",
        t3,
        "codex-mcp-client",
      ).params!.arguments,
    ).toEqual(asThread);

    // Outside T3, Codex _meta still wins over another env session.
    expect(
      fillInboxToolArguments(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "send_message",
            arguments: { body: "hi" },
            _meta: { threadId: CODEX_THREAD, "x-codex-turn-metadata": { turn_trigger: "user" } },
          },
        },
        "/work",
        "ses_OWN",
        { host: "claude-code", session: CLAUDE_SESSION, name: "Claude Code" },
        "codex-mcp-client",
      ).params!.arguments,
    ).toEqual({ body: "hi", project_path: "/work", agent_session: CODEX_THREAD, agent_host: "codex", agent_name: "Codex" });

    // Pi and ACP agents naming their own provider are adopted as the T3 thread.
    for (const host of ["claude-code", "codex", "pi", "acp", "t3"]) {
      expect(
        fillInboxToolArguments(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "hi", agent_host: host } } },
          "/work",
          "ses_OWN",
          t3,
        ).params!.arguments,
      ).toEqual(asThread);
    }

    // Qwen-over-ACP in T3 stays on the T3 thread.
    expect(
      inboxCallHostSession(
        t3,
        { home: "/nonexistent-qwen", parentPid: 999999, envSession: QWEN_SESSION },
        { "qwen-code/invocation": { sessionId: QWEN_SESSION } },
        "qwen-code",
      ),
    ).toEqual(t3);

    // Claude in T3 stays on the T3 thread.
    expect(inboxClaudeCallSession(t3, { host: "claude-code", session: CLAUDE_SESSION, name: "Claude Code" }, "claude-code")).toEqual(t3);
  });

  test.each([
    {
      provider: "Claude",
      clientInfo: { name: "claude-code", version: "2.1.317" },
      env: { T3CODE_THREAD_ID: THREAD, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION },
      toolArgs: { body: "Ship Claude?", agent_host: "claude-code", idempotency_key: "t3-claude-1" },
    },
    {
      provider: "Codex",
      clientInfo: { name: "codex-mcp-client", version: "0.160.0" },
      env: { T3CODE_THREAD_ID: THREAD, CODEX_THREAD_ID: CODEX_THREAD },
      toolArgs: { body: "Ship Codex?", agent_host: "codex", idempotency_key: "t3-codex-1" },
      meta: { threadId: CODEX_THREAD, "x-codex-turn-metadata": { turn_trigger: "user", turn_started_at_unix_ms: 1 } },
    },
    {
      provider: "Pi",
      clientInfo: { name: "pi-mcp", version: "1.0.0" },
      env: { T3CODE_THREAD_ID: THREAD, PI_SESSION_ID: "pi-session-1" },
      toolArgs: { body: "Ship Pi?", agent_host: "pi", idempotency_key: "t3-pi-1" },
    },
    {
      provider: "ACP",
      clientInfo: { name: "qwen-code", version: "0.24.0" },
      env: { T3CODE_THREAD_ID: THREAD, QWEN_CODE_SESSION_ID: QWEN_SESSION },
      toolArgs: { body: "Ship ACP?", agent_host: "acp", idempotency_key: "t3-acp-1" },
    },
  ])("$provider thread in T3 wakes on Inbox reply and delivers once to T3", async ({ provider, clientInfo, env, toolArgs, meta }) => {
    const box = scratch();
    const t3 = startFakeT3({ threads: [THREAD] });
    fakes.push(t3);
    new T3Credentials(box.dataDir, t3.endpoint).save({
      endpoint: t3.endpoint.href,
      epoch: "e1",
      tokens: { access_token: t3.state.token, token_type: "Bearer" },
    });
    const server = await startInboxServer({ dataDir: box.dataDir, binaryPath: null });
    servers.push(server);

    const reply = await runShimCall({ dataDir: box.dataDir, cwd: box.project, env, clientInfo, toolArgs, meta });
    expect(reply.error).toBeUndefined();
    expect(reply.result!.content![0]!.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    const sent = reply.result!.structuredContent!;
    const base = `http://127.0.0.1:${server.port}`;
    const readThread = async () => ((await (await fetch(`${base}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: InboxThread }).thread;
    expect((await readThread()).messages[0]).toMatchObject({
      author: { kind: "agent", host: "t3", session: THREAD, name: "T3 Code" },
      wakes: true,
    });

    const response = await fetch(`${base}/api/inbox/messages/${sent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `reply-${provider}`, words: `Go ahead (${provider}).` }),
    });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    await server.t3Wake.sweep();
    await server.t3Wake.sweep();
    expect(t3.turns).toEqual([
      {
        threadId: THREAD,
        message: expect.stringContaining(`Go ahead (${provider}).`),
        clientRequestId: `plannotator-inbox-${replyId}`,
        mode: "queue",
      },
    ]);
    expect((await readThread()).messages.at(-1)!.delivery).toMatchObject({ host: "t3", session: THREAD });
  });

  test("Codex in T3 with a read-only grant gets read-later text and wakes: false", async () => {
    const box = scratch();
    const t3 = startFakeT3({ threads: [THREAD], access: "read-only" });
    fakes.push(t3);
    new T3Credentials(box.dataDir, t3.endpoint).save({
      endpoint: t3.endpoint.href,
      epoch: "e1",
      tokens: { access_token: t3.state.token, token_type: "Bearer", scope: "orchestration:read" },
    });
    const server = await startInboxServer({ dataDir: box.dataDir, binaryPath: null });
    servers.push(server);

    const reply = await runShimCall({
      dataDir: box.dataDir,
      cwd: box.project,
      env: { T3CODE_THREAD_ID: THREAD, CODEX_THREAD_ID: CODEX_THREAD },
      clientInfo: { name: "codex-mcp-client", version: "0.160.0" },
      toolArgs: { body: "Read-only grant check", idempotency_key: "t3-ro-1" },
      meta: { threadId: CODEX_THREAD, "x-codex-turn-metadata": { turn_trigger: "user", turn_started_at_unix_ms: 1 } },
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result!.content![0]!.text).toContain(INBOX_REPLY_READ_LATER_TEXT);
    const sent = reply.result!.structuredContent!;
    const thread = ((await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: InboxThread }).thread;
    expect(thread.messages[0]).toMatchObject({ author: { kind: "agent", host: "t3", session: THREAD, name: "T3 Code" } });
    expect(thread.messages[0]!.wakes).not.toBe(true);
  });

  test("plannotator t3 --help documents Claude, Codex, Pi, and ACP setup", () => {
    expect(T3_CLI_USAGE).not.toContain("Only Claude threads in T3 wake");
    expect(T3_CLI_USAGE).toContain("[mcp_servers.plannotator-inbox]");
    expect(T3_CLI_USAGE).toContain("args = [\"inbox\", \"mcp\", \"--t3\"]");
    expect(T3_CLI_USAGE).toContain("Pi and ACP");
  });
});
