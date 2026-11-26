/**
 * A Mistral Vibe session the Inbox launched names itself to the Inbox MCP server through PLANNOTATOR_VIBE_SESSION,
 * which the launch host puts in that server's env (Vibe passes MCP servers no session id of its own). The failures
 * this catches: a launched Vibe's messages filed under the shim's random session (the reply would never reach it), a
 * malformed value taken as a session, and the Vibe variable winning over a session tag the shim inherited from a host
 * that does name itself.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { inboxHostSessionFromEnv } from "./inbox-mcp-shim";

const VIBE_SESSION = "7c2d9e10-4b3a-4f6e-8d21-0a1b2c3d4e5f";
const CLAUDE_SESSION = "0f3c2a51-7d4e-4b8a-9e21-5c6d7e8f9a0b";
const entry = resolve(import.meta.dir, "index.ts");

let stubs: string[] = [];
const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => removeStubbedHtml(stubs));
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const agents = stubbedAgentClis();

describe("a launched Mistral Vibe session's shim", () => {
  test("PLANNOTATOR_VIBE_SESSION names the session as Vibe", () => {
    expect(inboxHostSessionFromEnv({ PLANNOTATOR_VIBE_SESSION: VIBE_SESSION })).toEqual({ host: "mistral-vibe", session: VIBE_SESSION, name: "Vibe" });
  });
  test("a malformed value names nothing", () => {
    for (const bad of ["", "--yolo", "a b", "x".repeat(200)]) expect(inboxHostSessionFromEnv({ PLANNOTATOR_VIBE_SESSION: bad })).toBeNull();
  });
  test("a Plannotator session tag still wins", () => {
    expect(inboxHostSessionFromEnv({ PLANNOTATOR_VIBE_SESSION: VIBE_SESSION, PLANNOTATOR_SESSION_TAG: `claude-code:${CLAUDE_SESSION}` })?.host).toBe("claude-code");
  });
});

describe("a launched Mistral Vibe session over plannotator inbox mcp", () => {
  test("its messages are filed under that session, as Vibe", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-vibe-shim-")));
    roots.push(root);
    const dataDir = join(root, "data");
    const server = await startInboxServer({ dataDir, binaryPath: null });
    servers.push(server);
    // The env the launch host gives the server, plus what a test needs to stay in its sandbox.
    const env: Record<string, string> = {
      ...agents.env,
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      TMPDIR: tmpdir(),
      PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
      PLANNOTATOR_DATA_DIR: dataDir,
      NO_BROWSER,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_ANON_PING: "1",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_VIBE_SESSION: VIBE_SESSION,
    };
    const client = new Client({ name: "mistral-vibe", version: "3.1.3" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["run", entry, "inbox", "mcp"], cwd: root, env, stderr: "pipe" }));
    clients.push(client);
    const result = await client.callTool({ name: "send_message", arguments: { body: "Done with the readme.", idempotency_key: "vibe-1" } });
    const sent = result.structuredContent as { thread_id: string };
    const { thread } = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: InboxThread };
    expect(thread.messages[0]!.author).toMatchObject({ kind: "agent", host: "mistral-vibe", session: VIBE_SESSION, name: "Vibe" });
  }, 90_000);
});
