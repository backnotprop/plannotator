/**
 * `plannotator inbox mcp` started as an MCP server by a Pi or Oh My Pi
 * process that runs Plannotator's extension. OMP starts the MCP servers it
 * finds (its own `mcp.json`, other agents' configs) and gives them no session
 * variable, so the shim used to send as a fresh `ses_` id: a thread started
 * over MCP was nobody's the extension polls for, and the person's reply never
 * woke the session. The shim now reads, at each call, the session the
 * extension claims for its parent process (`inbox/pi-sessions/`). The parent
 * here is played by this test process: its pid is the one the claim names.
 * The Inbox is a fake that records what reached it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePiSessionClaim, writePiSessionClaim } from "@plannotator/shared/inbox/pi-session-claim";
import { inboxHostSessionFromEnv, inboxPiParentSession, runInboxMcpShim } from "./inbox-mcp-shim";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Args = Record<string, unknown>;

function dataDirFor(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "shim-pi-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

/**
 * One shim process whose parent is `parentPid`: `initialize`, then each call; `between(i)` runs before call i,
 * as the Pi session changes under the running server. The arguments each call reached the Inbox with.
 */
async function shimSends(dataDir: string, parentPid: number, calls: Args[], options: { env?: Record<string, string>; between?: (index: number) => void } = {}): Promise<Args[]> {
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
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "omp", version: "18.22.2" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ];
  const input = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
        await Bun.sleep(20);
      }
      for (const [index, args] of calls.entries()) {
        options.between?.(index);
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: { name: "send_message", arguments: args } })}\n`));
        // The call reaches the Inbox before the next change.
        const before = reached.length;
        for (let i = 0; i < 200 && reached.length === before; i++) await Bun.sleep(10);
      }
      controller.close();
    },
  });
  await runInboxMcpShim({
    dataDir,
    cwd: "/work/app",
    ensureRunning: async () => ({ v: 1, pid: process.pid, port: fake.port, url: "", version: "test", token: "t", serverSession: "s", startedAt: "" }) as never,
    hostSession: inboxHostSessionFromEnv(options.env ?? {}),
    piParent: () => inboxPiParentSession(dataDir, parentPid),
    input,
    write: () => {},
  });
  return reached;
}

const author = (args: Args) => ({ host: args.agent_host, session: args.agent_session, name: args.agent_name });
/** What the Pi extension's `plannotator_inbox` tool writes (PI_INBOX_HOST, PI_INBOX_AGENT_NAME), in Pi and in OMP. */
const piAuthor = (session: string) => ({ host: "pi", session, name: "Pi" });
const claim = (dataDir: string, session: string, owner = "ext-1") => writePiSessionClaim(dataDir, { session, pid: process.pid, rpc: false, title: process.title, owner });

describe("plannotator inbox mcp under a Pi or Oh My Pi session with the extension", () => {
  test("sends as the session the parent claims, the author the extension's own tool writes, so the reply wakes it", async () => {
    const dataDir = dataDirFor();
    claim(dataDir, "omp-session-a");
    const sent = await shimSends(dataDir, process.pid, [{ body: "a", reply_to: "msg_01" }]);
    expect(author(sent[0]!)).toEqual(piAuthor("omp-session-a"));
  });

  test("follows the session when it changes under the running server (/new, /resume, an OMP session switch)", async () => {
    const dataDir = dataDirFor();
    claim(dataDir, "omp-session-a");
    const sent = await shimSends(dataDir, process.pid, [{ body: "a", reply_to: "msg_01" }, { body: "b", reply_to: "msg_01" }], {
      between: (index) => {
        if (index === 1) claim(dataDir, "omp-session-b");
      },
    });
    expect(sent.map(author)).toEqual([piAuthor("omp-session-a"), piAuthor("omp-session-b")]);
  });

  test("the parent's claim wins over a variable the shim inherited from whatever started that Pi", async () => {
    const dataDir = dataDirFor();
    claim(dataDir, "omp-session-a");
    const sent = await shimSends(dataDir, process.pid, [{ body: "a", reply_to: "msg_01" }], {
      env: { PLANNOTATOR_SESSION_TAG: "claude-code:3f2b8c1e-7a4d-4e9b-9c2a-5d6e7f8a9b0c" },
    });
    expect(author(sent[0]!)).toEqual(piAuthor("omp-session-a"));
  });

  test("no claim for the parent (no extension, another process's claim, a session that ended) stays one ses_ per process", async () => {
    const dataDir = dataDirFor();
    // Another Pi's claim: not this shim's parent.
    writePiSessionClaim(dataDir, { session: "someone-else", pid: process.ppid, rpc: false, title: "pi", owner: "x" });
    const other = await shimSends(dataDir, process.pid, [{ body: "a", reply_to: "msg_01" }]);
    claim(dataDir, "omp-session-a");
    releasePiSessionClaim(dataDir, "omp-session-a", process.pid, "ext-1");
    const ended = await shimSends(dataDir, process.pid, [{ body: "b", reply_to: "msg_01" }]);
    for (const [sent] of [other, ended]) {
      expect(sent!.agent_session).toMatch(/^ses_/);
      expect(sent!.agent_host).toBeUndefined();
    }
  });

  test("the agent's own session or another host it names still wins", async () => {
    const dataDir = dataDirFor();
    claim(dataDir, "omp-session-a");
    const sent = await shimSends(dataDir, process.pid, [
      { body: "a", reply_to: "msg_01", agent_session: "my-own" },
      { body: "b", reply_to: "msg_01", agent_host: "cursor" },
    ]);
    expect(sent[0]!.agent_session).toBe("my-own");
    expect(sent[1]!.agent_session).toMatch(/^ses_/);
  });
});
