/**
 * `plannotator inbox pulls ls|add|rm` (approval "inbox-pr-binding",
 * 2026-11-08) against a stand-in Inbox in this process that records the call.
 * The failures these guard: `rm` with no ref that silently takes nothing off
 * (or everything); `--all` that does not reach the Inbox as `["all"]`; a ref
 * dropped on its way; the session the script names lost (so the change is
 * refused as not in the thread); and bad usage that exits like a refusal.
 * No real Inbox, gh or agent runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { parsePullsCommand, runInboxPullsCommand } from "./inbox-pulls-command";

const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** A stand-in /mcp that records each tools/call and answers like the Inbox. */
function standIn() {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { params: { name: string; arguments: Record<string, unknown> } };
      calls.push(body.params);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Thread msg_t: Added o/r#1." }], structuredContent: { thread_id: "msg_t", pulls: [] } } });
    },
  });
  servers.push(server);
  return { calls, entry: { port: server.port } as unknown as InboxRegistryEntry };
}

async function run(argv: string[], env: Record<string, string> = { PI_SESSION_ID: "pi-session-a" }) {
  const inbox = standIn();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runInboxPullsCommand(argv, { cwd: "/tmp", env, ensureRunning: async () => inbox.entry, out: (t) => void out.push(t), err: (t) => void err.push(t) });
  return { code, out: out.join(""), err: err.join(""), calls: inbox.calls };
}

describe("parse", () => {
  test("rm takes refs or --all, never neither or both; add takes refs; ls takes none", () => {
    expect(parsePullsCommand(["rm", "msg_t"]).ok).toBe(false);
    expect(parsePullsCommand(["rm", "msg_t", "o/r#1", "--all"]).ok).toBe(false);
    expect(parsePullsCommand(["add", "msg_t"]).ok).toBe(false);
    expect(parsePullsCommand(["ls", "msg_t", "o/r#1"]).ok).toBe(false);
    expect(parsePullsCommand(["list", "msg_t"]).ok).toBe(false);
    expect(parsePullsCommand(["rm", "--session", "ses_b", "msg_t", "--all"])).toEqual({ ok: true, op: "rm", thread: "msg_t", refs: [], all: true, session: "ses_b" });
  });
});

describe("run", () => {
  test("add sends every ref to thread_pulls as the script's session, and prints the result as JSON", async () => {
    const result = await run(["add", "msg_t", "o/r#1", "acme/api!3"]);
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.name).toBe("thread_pulls");
    expect(result.calls[0]!.arguments).toMatchObject({ thread_id: "msg_t", add: ["o/r#1", "acme/api!3"], agent_session: "pi-session-a", agent_host: "pi" });
    expect(JSON.parse(result.out)).toEqual({ thread_id: "msg_t", pulls: [] });
  });

  test("rm --all reaches the Inbox as remove [\"all\"]; ls sends neither", async () => {
    const rm = await run(["rm", "msg_t", "--all"]);
    expect(rm.calls[0]!.arguments).toMatchObject({ thread_id: "msg_t", remove: ["all"] });
    expect(rm.calls[0]!.arguments.add).toBeUndefined();
    const ls = await run(["ls", "msg_t"]);
    expect(ls.calls[0]!.arguments.add).toBeUndefined();
    expect(ls.calls[0]!.arguments.remove).toBeUndefined();
  });

  test("bad usage exits 2 with the usage, and calls nothing", async () => {
    const result = await run(["rm", "msg_t"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Usage:");
    expect(result.calls).toEqual([]);
  });
});
