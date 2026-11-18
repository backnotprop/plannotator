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
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePiSessionClaim, writePiSessionClaim } from "@plannotator/shared/inbox/pi-session-claim";
import { inboxClaudeMcpSessionFromEnv, inboxHostSessionFromEnv, inboxQwenShimContext, inboxPiParentReader, inboxPiParentSession, processStartedAtMs, runInboxMcpShim } from "./inbox-mcp-shim";

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
async function shimSends(
  dataDir: string,
  parentPid: number,
  calls: Args[],
  options: { env?: Record<string, string>; between?: (index: number) => void; client?: string; parentStartedMs?: number | null; qwenHome?: string } = {},
): Promise<Args[]> {
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
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: options.client ?? "omp", version: "18.22.2" } } },
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
    claude: inboxClaudeMcpSessionFromEnv(options.env ?? {}),
    ...(options.qwenHome ? { qwen: inboxQwenShimContext({ ...options.env, QWEN_HOME: options.qwenHome }, options.qwenHome, "/work/app", parentPid) } : {}),
    piParent: () => inboxPiParentSession(dataDir, parentPid, options.parentStartedMs ?? null),
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

  // Deliberate: the parent's live claim beats a tag the shim only inherited (an OMP started from a Claude Code shell
  // carries that session's PLANNOTATOR_SESSION_TAG, which names the wrong agent here). An identity a client confirms
  // still wins over the claim: the Claude Code test below.
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

  test("an identity a client confirms wins over a claim for the parent: Claude Code's own MCP session", async () => {
    const dataDir = dataDirFor();
    claim(dataDir, "omp-session-a");
    const session = "3f2b8c1e-7a4d-4e9b-9c2a-5d6e7f8a9b0c";
    const sent = await shimSends(dataDir, process.pid, [{ body: "a", reply_to: "msg_01" }], {
      env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session },
      client: "claude-code",
    });
    expect(author(sent[0]!)).toEqual({ host: "claude-code", session, name: "Claude Code" });
  });

  test.skipIf(process.platform === "win32")("a claim a killed process left under a pid the parent now reuses is ignored", async () => {
    const dataDir = dataDirFor();
    claim(dataDir, "dead-session");
    // Written before the process now running as this pid started: a dead process's, never released.
    const started = processStartedAtMs(process.pid);
    expect(started).not.toBeNull();
    const dir = join(dataDir, "inbox", "pi-sessions");
    const before = new Date(started! - 60_000);
    for (const name of readdirSync(dir)) utimesSync(join(dir, name), before, before);
    const stale = await shimSends(dataDir, process.pid, [{ body: "a", reply_to: "msg_01" }], { parentStartedMs: started });
    expect(stale[0]!.agent_session).toMatch(/^ses_/);
    expect(stale[0]!.agent_host).toBeUndefined();
    // The live process claims its session again (a session start, /new): taken at once.
    claim(dataDir, "live-session");
    const live = await shimSends(dataDir, process.pid, [{ body: "b", reply_to: "msg_01" }], { parentStartedMs: started });
    expect(author(live[0]!)).toEqual(piAuthor("live-session"));
  });

  test.skipIf(process.platform === "win32")("a process's start time is read right, in a time zone that is not UTC", () => {
    const savedTz = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      const started = processStartedAtMs(process.pid);
      expect(started).not.toBeNull();
      // Whole seconds, a little early: within a few seconds of when this process began.
      expect(Math.abs(started! - (Date.now() - process.uptime() * 1000))).toBeLessThan(5000);
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  test("a parent that claims no session (not Pi or Oh My Pi) never has its start time read; one that does, once", () => {
    const dataDir = dataDirFor();
    let reads = 0;
    const read = inboxPiParentReader(dataDir, () => process.pid, () => {
      reads += 1;
      return null;
    });
    expect(read()).toBeNull();
    expect(read()).toBeNull();
    expect(reads).toBe(0);
    claim(dataDir, "omp-session-a");
    expect(read()).toEqual(piAuthor("omp-session-a"));
    expect(read()).toEqual(piAuthor("omp-session-a"));
    expect(reads).toBe(1);
  });

  test("an OMP started from a Qwen Code shell: the Qwen variable it inherited does not hide its own session", async () => {
    const dataDir = dataDirFor();
    claim(dataDir, "omp-session-a");
    // No Qwen registry record for this parent (it is OMP, not Qwen), and the client is OMP's.
    const sent = await shimSends(dataDir, process.pid, [{ body: "a", reply_to: "msg_01" }], {
      env: { QWEN_CODE_SESSION_ID: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f" },
      qwenHome: dataDirFor(),
    });
    expect(author(sent[0]!)).toEqual(piAuthor("omp-session-a"));
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
