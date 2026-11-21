/**
 * Re-ask all through the server's real doors (`POST /api/inbox/threads/:id/reask`, shared/inbox/reask-all.ts): the
 * window's route and its guards, the wake a waking connection polls (the Re-ask wake line, never the reply's, and
 * nothing asking the agent to archive), no second note for a session that has not taken the first, and a session that ended (a waking
 * connection, not heard from past the grace) counted and never written to. Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_POLL_PATH,
  INBOX_REASK_INSTRUCTION,
  INBOX_WAKE_INSTRUCTION,
  INBOX_WAKES_META_KEY,
  inboxWakeText,
  parseInboxBridgeCommands,
} from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_ASKER_RESTART_GRACE_MS } from "./inbox-sessions";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  let now = 1_000_000;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reask-all-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, sessionsNow: () => now });
  servers.push(server);
  const client = new Client({ name: "inbox-reask-all-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, pass: (ms = INBOX_ASKER_RESTART_GRACE_MS + 1) => void (now += ms) };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const block = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

/** A waking session asks (its connection wakes it: the only kind that can be told ended). */
async function ask(client: Client, project: string, session: string, body: string, reply_to?: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", body, ...(reply_to ? { reply_to } : {}) },
    _meta: { [INBOX_WAKES_META_KEY]: true },
  });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as { message_id: string; thread_id: string };
}

const reaskAll = (server: InboxServer, threadId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base(server)}/api/inbox/threads/${threadId}/reask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
const poll = async (server: InboxServer, session: string, project: string) =>
  parseInboxBridgeCommands(
    await (
      await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ session, host: "claude-code", project_path: project, waitMs: 0 }),
      })
    ).text(),
  );
async function thread(server: InboxServer, id: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
}

describe("Re-ask all over the window's route", () => {
  test("a live session is asked once, and its wake is the Re-ask wake, asking for no archive; a second press stacks nothing", async () => {
    const { server, client, project } = await setup();
    const asked = await ask(client, project, "ses-a", `Two calls.\n\n${block("Backfill the ledger first?")}\n\n${block("Keep the old webhook?")}`);
    await poll(server, "ses-a", project);
    const first = (await (await reaskAll(server, asked.thread_id, { batch_id: "press-1" })).json()) as { asked: { reply_id: string }[]; unreached: unknown[] };
    expect(first.asked).toHaveLength(1);
    expect(first.unreached).toEqual([]);
    const [command] = (await poll(server, "ses-a", project)).filter((c) => c.type === "reply");
    expect(command).toMatchObject({ type: "reply", id: first.asked[0]!.reply_id, reask: true });
    const wake = inboxWakeText(command!);
    expect(wake.split("\n")[1]).toBe(INBOX_REASK_INSTRUCTION);
    expect(wake).not.toContain(INBOX_WAKE_INSTRUCTION);
    expect(wake.toLowerCase()).not.toContain("archive");
    expect(wake).not.toContain("resolve_message");
    const again = (await (await reaskAll(server, asked.thread_id, { batch_id: "press-2" })).json()) as { asked: unknown[] };
    expect(again.asked).toEqual([]);
    expect((await thread(server, asked.thread_id)).messages.filter((m) => m.author.kind === "person")).toHaveLength(1);
  });

  test("a session that ended is counted and gets nothing", async () => {
    const { server, client, project, pass } = await setup();
    const asked = await ask(client, project, "ses-gone", `One call.\n\n${block("Move refunds now?")}`);
    await poll(server, "ses-gone", project);
    pass();
    const result = (await (await reaskAll(server, asked.thread_id, { batch_id: "press-1" })).json()) as { asked: unknown[]; unreached: { session: string }[] };
    expect(result.asked).toEqual([]);
    expect(result.unreached.map((s) => s.session)).toEqual(["ses-gone"]);
    expect((await thread(server, asked.thread_id)).messages.filter((m) => m.author.kind === "person")).toEqual([]);
  });

  test("guards: another site, a stale tab, a bad key, an unknown thread; nothing written", async () => {
    const { server, client, project } = await setup();
    const asked = await ask(client, project, "ses-a", `One call.\n\n${block("Move refunds now?")}`);
    expect((await reaskAll(server, asked.thread_id, { batch_id: "x1" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await reaskAll(server, asked.thread_id, { batch_id: "x2", serverSession: "stale" })).status).toBe(409);
    expect((await reaskAll(server, asked.thread_id, { batch_id: "no spaces" })).status).toBe(422);
    expect((await reaskAll(server, "msg_01K7000000000000000000NONE", { batch_id: "x3" })).status).toBe(404);
    expect((await thread(server, asked.thread_id)).messages.filter((m) => m.author.kind === "person")).toEqual([]);
  });
});
