import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { INBOX_REPLY_READ_LATER_TEXT } from "@plannotator/server/inbox-mcp";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { inboxHostSessionFromEnv } from "./inbox-mcp-shim";

const entry = resolve(import.meta.dir, "index.ts");
const MUSE_SESSION = "3b7e1f20-5c4d-4e8a-9b1c-2d3e4f5a6b7c";
const CLAUDE_SESSION = "0f3c2a51-7d4e-4b8a-9e21-5c6d7e8f9a0b";
const MUSE = { host: "muse", session: MUSE_SESSION, name: "Muse Code" };

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

async function museShim(dataDir: string, cwd: string): Promise<Client> {
  const env: Record<string, string> = {
    ...agents.env,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: dataDir,
    NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: "1",
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
    MUSE_SESSION_ID: MUSE_SESSION,
  };
  const client = new Client({ name: "muse", version: "1.4.13" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["run", entry, "inbox", "mcp"], cwd, env, stderr: "pipe" }));
  clients.push(client);
  return client;
}

describe("a Muse Code session over plannotator inbox mcp", () => {
  test("MUSE_SESSION_ID names the session; a Plannotator tag or another host's own variable still wins", () => {
    expect(inboxHostSessionFromEnv({ MUSE_SESSION_ID: MUSE_SESSION })).toEqual(MUSE);
    expect(inboxHostSessionFromEnv({ MUSE_SESSION_ID: MUSE_SESSION, PLANNOTATOR_SESSION_TAG: `claude-code:${CLAUDE_SESSION}` })?.host).toBe("claude-code");
    expect(inboxHostSessionFromEnv({ MUSE_SESSION_ID: MUSE_SESSION, PI_SESSION_ID: "pi-1" })?.host).toBe("pi");
    for (const bad of ["", "--yolo", "a b"]) expect(inboxHostSessionFromEnv({ MUSE_SESSION_ID: bad })).toBeNull();
  });

  test("sends as its session, is told the reply will not wake it, and a later shim of the same session reads the reply", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-muse-shim-")));
    roots.push(root);
    const dataDir = join(root, "data");
    const server = await startInboxServer({ dataDir, binaryPath: null });
    servers.push(server);

    const first = await museShim(dataDir, root);
    const result = await first.callTool({ name: "send_message", arguments: { body: "Ship the worker today?", idempotency_key: "muse-1" } });
    expect((result.content as { text: string }[])[0]!.text).toContain(INBOX_REPLY_READ_LATER_TEXT);
    const sent = result.structuredContent as { message_id: string; thread_id: string };
    const base = `http://127.0.0.1:${server.port}`;
    const { thread } = (await (await fetch(`${base}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: InboxThread };
    expect(thread.messages[0]!.author).toMatchObject({ kind: "agent", ...MUSE });
    expect(thread.messages[0]!.wakes).toBeFalsy();

    const reply = await fetch(`${base}/api/inbox/messages/${sent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "person-1", words: "Yes, ship it." }),
    });
    expect(reply.status).toBe(200);
    await first.close();

    const next = await museShim(dataDir, root);
    const mine = (await next.callTool({ name: "read_thread", arguments: {} })).structuredContent as { threads: { thread_id: string }[] };
    expect(mine.threads.map((t) => t.thread_id)).toEqual([sent.thread_id]);
    const read = (await next.callTool({ name: "read_thread", arguments: { thread_id: sent.thread_id } })).structuredContent as { thread: { messages: { body: string }[] } };
    expect(read.thread.messages.at(-1)!.body).toContain("Yes, ship it.");
  }, 90_000);
});
