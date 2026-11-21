/**
 * `InboxAgentConnection.sessionThreads` (Pi's thread list after a compaction)
 * against an Inbox from before the peek mark. The failure this catches: the
 * connection reads the list from an Inbox that ignores the mark, which then
 * makes a project for every folder that compacts. A stand-in Inbox on a
 * loopback port answers health; the data dir is a temp folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InboxAgentConnection, inboxRegistryFileOf } from "./agent-link";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const THREAD = "msg_01M5WQ58NAVGBFZS4QKFBE1TCC";

/** A stand-in Inbox whose health has `peek` or not; records the /mcp calls. */
function standIn(peek: boolean) {
  const mcp: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/inbox/health") return Response.json({ ok: true, app: "plannotator-inbox", serverSession: "srv", ...(peek ? { peek: true } : {}) });
      if (url.pathname === "/mcp") {
        mcp.push(await request.json());
        const result = {
          content: [{ type: "text", text: "1 thread." }],
          structuredContent: { threads: [{ thread_id: THREAD, subject: "Plan", questions: { open: 0 }, last_author: "agent", last_at: "2026-10-27T06:24:00.000Z" }], total: 1 },
        };
        return Response.json({ jsonrpc: "2.0", id: 1, result });
      }
      return new Response("", { status: 404 });
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-link-threads-"));
  const registry = inboxRegistryFileOf(dataDir);
  mkdirSync(dirname(registry), { recursive: true });
  writeFileSync(registry, JSON.stringify({ v: 1, pid: 1, port: server.port, token: "t".repeat(40), serverSession: "srv", url: `http://127.0.0.1:${server.port}` }));
  cleanups.push(() => {
    server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { mcp, connection: new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: [] }) };
}

describe("InboxAgentConnection.sessionThreads", () => {
  test("an Inbox from before the peek mark (no peek in its health): no list, and its /mcp is never called", async () => {
    const { mcp, connection } = standIn(false);
    expect(await connection.sessionThreads({ sessionId: "ses-1", cwd: "/work" })).toBeNull();
    expect(mcp).toEqual([]);
  });

  test("an Inbox that honours the mark: the list, read as a peek", async () => {
    const { mcp, connection } = standIn(true);
    expect(await connection.sessionThreads({ sessionId: "ses-1", cwd: "/work" })).toContain(`- ${THREAD} · "Plan"`);
    expect((mcp[0] as { params: { _meta: Record<string, unknown> } }).params._meta).toEqual({ "ai.plannotator/inbox-peek": true });
  });
});
