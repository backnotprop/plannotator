/**
 * `plannotator inbox mcp` and T3 Code: a Claude that T3 runs through the Agent
 * SDK (T3CODE_THREAD_ID, CLAUDECODE, an `sdk-ts` entrypoint, AI_AGENT) sends
 * as its T3 thread, and the person's reply reaches a scripted T3 on loopback
 * (tests/helpers/fake-t3.ts) once. The `--t3` entry lists its tools only inside
 * a T3 thread, and an entry without the flag lists them exactly as before, in
 * an interactive Claude Code too.
 *
 * The Inbox runs in this process (`startInboxServer` on a scratch data dir,
 * which writes the registry the shim reads), so no detached Inbox is started
 * or signalled. The shim's environment is built from scratch: nothing of the
 * shell that runs the tests (an agent's own session variables) reaches it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { INBOX_REPLY_ARRIVES_TEXT } from "@plannotator/server/inbox-mcp";
import { readInboxRegistry } from "@plannotator/shared/inbox/registry";
import { T3Credentials } from "@plannotator/t3-code/auth";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { type FakeT3, startFakeT3, T3_THREAD_ID_FORMS } from "../../../tests/helpers/fake-t3";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { fillInboxToolArguments, inboxHostSessionFromEnv, inboxT3EntryIdle, runInboxMcpShim } from "./inbox-mcp-shim";

const entry = resolve(import.meta.dir, "index.ts");
const THREAD = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const CODEX_THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const CLAUDE_SESSION = "0f3c2a51-7d4e-4b8a-9e21-5c6d7e8f9a0b";
/** What T3 gives the Claude it runs: its thread, Claude's own markers (an SDK entrypoint), and Claude Code's AI_AGENT. */
const T3_CLAUDE = { T3CODE_THREAD_ID: THREAD, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", AI_AGENT: "claude-code_2-1-317_harness" };
/** An interactive Claude Code, with no T3 anywhere. */
const INTERACTIVE_CLAUDE = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", AI_AGENT: "claude-code_2-1-317_harness" };

let stubs: string[] = [];
const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const fakes: FakeT3[] = [];

beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => removeStubbedHtml(stubs));
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const fake of fakes.splice(0)) fake.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// After the cleanup hooks: a stub's failure stops the hooks registered behind it.
const agents = stubbedAgentClis();

function scratch(): { root: string; dataDir: string; project: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-t3-shim-")));
  roots.push(root);
  return { root, dataDir: join(root, "data"), project: root };
}

/** The shim's whole environment: the sandbox, and only the agent variables the test names. */
function shimEnv(dataDir: string, agent: Record<string, string>): Record<string, string> {
  return {
    ...agents.env,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: dataDir,
    NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: "1",
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
    ...agent,
  };
}

async function shim(dataDir: string, cwd: string, args: string[], agent: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "claude-code", version: "2.1.317" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["run", entry, "inbox", "mcp", ...args], cwd, env: shimEnv(dataDir, agent), stderr: "pipe" }));
  clients.push(client);
  return client;
}

/** The tools the Inbox itself lists, asked directly. */
async function serverTools(server: InboxServer): Promise<string[]> {
  const client = new Client({ name: "direct", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

describe("the T3 thread as the shim's session", () => {
  test("T3CODE_THREAD_ID comes after the Plannotator tag and before every other host's variable; any id T3 gives a thread counts", () => {
    const t3 = { host: "t3", session: THREAD, name: "T3 Code" };
    expect(inboxHostSessionFromEnv(T3_CLAUDE)).toEqual(t3);
    expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: `t3:${THREAD}` })).toEqual(t3);
    expect(inboxHostSessionFromEnv({ ...T3_CLAUDE, PLANNOTATOR_SESSION_TAG: `claude-code:${CLAUDE_SESSION}` })?.host).toBe("claude-code");
    expect(inboxHostSessionFromEnv({ ...T3_CLAUDE, CODEX_THREAD_ID: CODEX_THREAD, PI_SESSION_ID: "pi-1" })).toEqual(t3);
    // DSH stands down beside Claude's markers, as before.
    expect(inboxHostSessionFromEnv({ ...T3_CLAUDE, DSH_SHELL: "1", DSH_SESSION_ID: "session-s" })).toEqual(t3);
    // A launched, scheduled, delegated or provider thread is the thread too: T3 takes a send into each.
    for (const id of Object.values(T3_THREAD_ID_FORMS)) {
      expect(inboxHostSessionFromEnv({ ...T3_CLAUDE, T3CODE_THREAD_ID: id })).toEqual({ ...t3, session: id });
      expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: `t3:${id}` })).toEqual({ ...t3, session: id });
    }
    // Nothing T3 would give a thread: no session, never a guess.
    for (const id of ["", " ", `:${THREAD}`, `${THREAD} `, `${THREAD}\nPI_SESSION_ID=x`, "thread/../x", `a${"b".repeat(1024)}`]) {
      expect(inboxHostSessionFromEnv({ ...T3_CLAUDE, T3CODE_THREAD_ID: id })).toBeNull();
      expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: `t3:${id}` })).toBeNull();
    }
  });

  test("the agent naming no host, t3 or claude-code is the thread; naming any other host is not", () => {
    const fill = (args: Record<string, unknown>, host: { host: string; session: string; name: string }) =>
      fillInboxToolArguments({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: args } }, "/work", "ses_OWN", host).params!.arguments;
    const t3 = { host: "t3", session: THREAD, name: "T3 Code" };
    const asThread = { body: "hi", project_path: "/work", agent_session: THREAD, agent_host: "t3", agent_name: "T3 Code" };
    expect(fill({ body: "hi" }, t3)).toEqual(asThread);
    expect(fill({ body: "hi", agent_host: "t3" }, t3)).toEqual(asThread);
    expect(fill({ body: "hi", agent_host: "claude-code" }, t3)).toEqual(asThread);
    // Another host is not this thread: a reply to it must not wake the thread.
    expect(fill({ body: "hi", agent_host: "codex" }, t3)).toEqual({ body: "hi", project_path: "/work", agent_session: "ses_OWN", agent_host: "codex" });
    expect(fill({ body: "hi", agent_host: "gemini" }, t3)).toMatchObject({ agent_session: "ses_OWN" });
    // Only a T3 thread takes another host's name: a Claude Code session that names t3 is not adopted.
    const claude = { host: "claude-code", session: CLAUDE_SESSION, name: "Claude Code" };
    expect(fill({ body: "hi", agent_host: "t3" }, claude)).toMatchObject({ agent_session: "ses_OWN", agent_host: "t3" });
  });

  test.each(Object.entries(T3_THREAD_ID_FORMS))("a T3 Claude's shim (--t3) in a thread of the %s form sends as its thread, and the person's reply reaches T3 once under the item's request id", async (_form, THREAD) => {
    const box = scratch();
    const t3 = startFakeT3({ threads: [THREAD] });
    fakes.push(t3);
    new T3Credentials(box.dataDir, t3.endpoint).save({ endpoint: t3.endpoint.href, epoch: "e1", tokens: { access_token: t3.state.token, token_type: "Bearer" } });
    const server = await startInboxServer({ dataDir: box.dataDir, binaryPath: null });
    servers.push(server);

    const client = await shim(box.dataDir, box.project, ["--t3"], { ...T3_CLAUDE, T3CODE_THREAD_ID: THREAD });
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(await serverTools(server));
    // The agent names itself claude-code, as Claude in T3 may: still the thread.
    const result = await client.callTool({ name: "send_message", arguments: { body: "Ship the worker today?", agent_host: "claude-code", idempotency_key: "t3-1" } });
    expect((result.content as { text: string }[])[0]!.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    const sent = result.structuredContent as { message_id: string; thread_id: string };
    const base = `http://127.0.0.1:${server.port}`;
    const thread = async () => ((await (await fetch(`${base}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: InboxThread }).thread;
    expect((await thread()).messages[0]).toMatchObject({ author: { kind: "agent", host: "t3", session: THREAD, name: "T3 Code" }, wakes: true });

    const response = await fetch(`${base}/api/inbox/messages/${sent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "person-1", words: "Yes, ship it." }),
    });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    await server.t3Wake.sweep();
    await server.t3Wake.sweep();
    expect(t3.turns).toEqual([{ threadId: THREAD, message: expect.stringContaining("Yes, ship it."), clientRequestId: `plannotator-inbox-${replyId}`, mode: "queue" }]);
    expect((await thread()).messages.at(-1)!.delivery).toMatchObject({ host: "t3", session: THREAD });
  }, 60_000);
});

describe("nothing changes for Claude Code users not on T3", () => {
  test("a plain entry in an interactive Claude Code lists the Inbox's tools, as before", async () => {
    const box = scratch();
    const server = await startInboxServer({ dataDir: box.dataDir, binaryPath: null });
    servers.push(server);
    const client = await shim(box.dataDir, box.project, [], INTERACTIVE_CLAUDE);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toContain("send_message");
    expect(tools).toEqual(await serverTools(server));
  }, 60_000);

  test("a --t3 entry outside a T3 thread lists no tools, refuses a call, and never starts or reaches the Inbox", async () => {
    for (const agent of [INTERACTIVE_CLAUDE, {}, { ...INTERACTIVE_CLAUDE, T3CODE_THREAD_ID: `:${THREAD}` }]) {
      const box = scratch();
      const client = await shim(box.dataDir, box.project, ["--t3"], agent);
      expect((await client.listTools()).tools).toEqual([]);
      const call = await client.callTool({ name: "send_message", arguments: { body: "hi" } }).then(
        () => null,
        (error: Error) => error,
      );
      expect(call?.message).toContain("only inside a T3 Code thread");
      expect(readInboxRegistry(box.dataDir)).toBeNull();
    }
  }, 90_000);

  test("whether a --t3 entry is idle reads the flag and T3's variable, nothing else", () => {
    expect(inboxT3EntryIdle(false, {})).toBe(false);
    expect(inboxT3EntryIdle(false, INTERACTIVE_CLAUDE)).toBe(false);
    expect(inboxT3EntryIdle(true, INTERACTIVE_CLAUDE)).toBe(true);
    expect(inboxT3EntryIdle(true, T3_CLAUDE)).toBe(false);
    expect(inboxT3EntryIdle(true, { ...T3_CLAUDE, T3CODE_THREAD_ID: T3_THREAD_ID_FORMS.delegated })).toBe(false);
    // An SDK session that is not T3's (claude -p, another SDK app): the flag's entry stays idle there too.
    expect(inboxT3EntryIdle(true, { ...T3_CLAUDE, T3CODE_THREAD_ID: undefined })).toBe(true);
  });

  test("the in-process shim with an idle --t3 entry answers on its own", async () => {
    const lines: string[] = [];
    let ensured = 0;
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.317" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    await runInboxMcpShim({
      dataDir: scratch().dataDir,
      cwd: tmpdir(),
      ensureRunning: async () => {
        ensured++;
        throw new Error("never reached");
      },
      t3EntryIdle: true,
      input: new Blob([messages.map((m) => `${JSON.stringify(m)}\n`).join("")]).stream(),
      write: (line) => lines.push(line),
    });
    const replies = lines.map((line) => JSON.parse(line) as { id: number; result?: { tools?: unknown[]; serverInfo?: { name: string } } });
    expect(replies.find((r) => r.id === 1)?.result?.serverInfo?.name).toBe("plannotator-inbox");
    expect(replies.find((r) => r.id === 2)?.result?.tools).toEqual([]);
    expect(ensured).toBe(0);
  });

  test("an unknown inbox mcp option is still refused", async () => {
    const box = scratch();
    const proc = Bun.spawn([process.execPath, "run", entry, "inbox", "mcp", "--t4"], { cwd: box.root, env: shimEnv(box.dataDir, {}), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown inbox mcp option: --t4");
  }, 30_000);
});
