/**
 * `plannotator inbox mcp` started by Claude Code itself as a stdio MCP server
 * (#3309): Claude Code gives the server `CLAUDECODE=1` and
 * `CLAUDE_CODE_SESSION_ID`, and the mod's `PLANNOTATOR_SESSION_TAG` may not be
 * there (the servers start before the mod's `session.start`). Every shim of
 * one session, a reconnect's included, must send as that session, the same
 * author the mod's `plannotator_inbox` tool writes; anything else that only
 * looks like it must not. The Inbox is a fake that records what reached it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_AGENT_NAME, INBOX_HOST } from "../hooks/mod/inbox";
import { inboxClaudeMcpSessionFromEnv, inboxHostSessionFromEnv, runInboxMcpShim } from "./inbox-mcp-shim";

const SESSION = "3f2b8c1e-7a4d-4e9b-9c2a-5d6e7f8a9b0c";
const OTHER_SESSION = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const T3_THREAD = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";

/** What Claude Code puts in a stdio MCP server's environment (2.1.323), with no tag from the mod. */
const CLAUDE_MCP_ENV = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: "/work/app" };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Args = Record<string, unknown>;

/** One shim process's life: `initialize` as `clientName`, then each call; the arguments each call reached the Inbox with. */
async function shimSends(env: Record<string, string | undefined>, clientName: string, calls: Args[]): Promise<Args[]> {
  const reached: Args[] = [];
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const message = (await request.json()) as { id?: number; method?: string; params?: { arguments?: Args } };
      if (message.method === "tools/call") reached.push(message.params?.arguments ?? {});
      if (message.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } : { content: [] } });
    },
  });
  cleanups.push(() => fake.stop(true));
  const dataDir = mkdtempSync(join(tmpdir(), "shim-claude-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "2.1.323" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...calls.map((args, index) => ({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: "send_message", arguments: args } })),
  ];
  // One line at a time, as a client waits for `initialize`'s answer before it calls a tool.
  const input = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
        await Bun.sleep(20);
      }
      controller.close();
    },
  });
  await runInboxMcpShim({
    dataDir,
    cwd: "/work/app",
    ensureRunning: async () => ({ v: 1, pid: process.pid, port: fake.port, url: "", version: "test", token: "t", serverSession: "s", startedAt: "" }) as never,
    hostSession: inboxHostSessionFromEnv(env),
    claude: inboxClaudeMcpSessionFromEnv(env),
    input,
    write: () => {},
  });
  return reached;
}

const author = (args: Args) => ({ host: args.agent_host, session: args.agent_session, name: args.agent_name });
const MOD_AUTHOR = { host: INBOX_HOST, session: SESSION, name: INBOX_AGENT_NAME };

describe("plannotator inbox mcp under Claude Code (#3309)", () => {
  test("every shim one Claude Code session starts, a reconnect's too, sends as that session, as the mod's tool does", async () => {
    const first = await shimSends(CLAUDE_MCP_ENV, "claude-code", [
      { body: "first", reply_to: "msg_01", thread: "thr" },
      { body: "second", reply_to: "msg_02", thread: "thr" },
    ]);
    // Claude Code started the server again (a reconnect): a new process, the same session.
    const reconnected = await shimSends(CLAUDE_MCP_ENV, "claude-code", [{ body: "third", reply_to: "msg_03" }]);
    expect([...first, ...reconnected].map(author)).toEqual([MOD_AUTHOR, MOD_AUTHOR, MOD_AUTHOR]);
  });

  test("two Claude Code sessions in one project stay two", async () => {
    const one = await shimSends(CLAUDE_MCP_ENV, "claude-code", [{ body: "a", reply_to: "msg_01" }]);
    const two = await shimSends({ ...CLAUDE_MCP_ENV, CLAUDE_CODE_SESSION_ID: OTHER_SESSION }, "claude-code", [{ body: "b", reply_to: "msg_01" }]);
    expect(one[0]!.agent_session).toBe(SESSION);
    expect(two[0]!.agent_session).toBe(OTHER_SESSION);
  });

  test("Claude Code's own session wins over a tag the shim inherited from the session that started this Claude Code", async () => {
    const sent = await shimSends({ ...CLAUDE_MCP_ENV, PLANNOTATOR_SESSION_TAG: `claude-code:${OTHER_SESSION}`, PI_SESSION_ID: "pi-outer" }, "claude-code", [{ body: "a", reply_to: "msg_01" }]);
    expect(author(sent[0]!)).toEqual(MOD_AUTHOR);
  });

  test("what only looks like Claude Code's server stays a stranger", async () => {
    // An agent started from a Claude Code shell inherits CLAUDECODE and the session id, and CLAUDE_CODE_CHILD_SESSION with them.
    const fromShell = await shimSends({ ...CLAUDE_MCP_ENV, CLAUDE_CODE_CHILD_SESSION: "1" }, "claude-code", [{ body: "a", reply_to: "msg_01" }]);
    // Another MCP client whose process carries Claude Code's variables.
    const otherClient = await shimSends(CLAUDE_MCP_ENV, "gemini-cli-mcp-client", [{ body: "b", reply_to: "msg_01" }]);
    // Not a Claude Code session id.
    const malformed = await shimSends({ ...CLAUDE_MCP_ENV, CLAUDE_CODE_SESSION_ID: "abc" }, "claude-code", [{ body: "c", reply_to: "msg_01" }]);
    for (const [sent] of [fromShell, otherClient, malformed]) {
      expect(sent!.agent_session).toMatch(/^ses_/);
      expect(sent!.agent_host).toBeUndefined();
    }
  });

  test("an agent's own session or other host still wins, and a T3 Code thread stays the thread", async () => {
    const own = await shimSends(CLAUDE_MCP_ENV, "claude-code", [
      { body: "a", reply_to: "msg_01", agent_session: "my-own" },
      { body: "b", reply_to: "msg_01", agent_host: "cursor" },
    ]);
    expect(own[0]!.agent_session).toBe("my-own");
    expect(own[1]!.agent_session).toMatch(/^ses_/);
    const t3 = await shimSends({ ...CLAUDE_MCP_ENV, T3CODE_THREAD_ID: T3_THREAD }, "claude-code", [{ body: "c", reply_to: "msg_01" }]);
    expect(author(t3[0]!)).toEqual({ host: "t3", session: T3_THREAD, name: "T3 Code" });
  });
});
