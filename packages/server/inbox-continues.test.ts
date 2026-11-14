/**
 * A reply after the conversation moved to a new session id, through the
 * server's real doors: the reply route, the connection's poll (`continues`)
 * and its `delivered` event, and the list row. The failures these guard: the
 * person's reply waiting for good on a session id that will never poll again
 * until the agent writes in the thread; the reply handed again after it was
 * delivered; a `delivered` from the continuing session refused; the row
 * saying "Session ended" while its conversation goes on; the wake's words
 * changing because another session id took it. Every test uses its own temp
 * data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_CONTINUES_POLL_FIELD,
  INBOX_SESSION_LIVE_MS,
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

/** An Inbox on a clock the test moves, and a thread a waking session started. */
async function world() {
  let now = 1_000_000;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-continues-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), sessionsNow: () => now });
  servers.push(server);
  const client = new Client({ name: "inbox-continues-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const asked = (
    await client.callTool({
      name: "send_message",
      arguments: { body: "Which runner should the nightly use?", project_path: project, agent_session: "ses-old", agent_host: "claude-code", agent_name: "Claude Code" },
      _meta: { [INBOX_WAKES_META_KEY]: true },
    })
  ).structuredContent as { message_id: string; thread_id: string };
  const bridge = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });
  const poll = async (session: string, continues?: string[]) => {
    const response = await bridge(INBOX_BRIDGE_POLL_PATH, { session, host: "claude-code", project_path: project, waitMs: 0, ...(continues ? { [INBOX_CONTINUES_POLL_FIELD]: continues } : {}) });
    expect(response.status).toBe(200);
    return parseInboxBridgeCommands(await response.text());
  };
  let key = 0;
  const personReplies = async (words: string) => {
    const response = await fetch(`${base}/api/inbox/messages/${asked.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k${(key += 1)}`, words }),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { reply: { id: string } }).reply;
  };
  const thread = async () => ((await (await fetch(`${base}/api/inbox/threads/${asked.thread_id}`)).json()) as { thread: InboxThread }).thread;
  const row = async () => {
    const list = (await (await fetch(`${base}/api/inbox/threads?archived=exclude`)).json()) as { sections: { id: string; threads: InboxListRow[] }[] };
    return list.sections.flatMap((section) => section.threads).find((r) => r.thread_id === asked.thread_id)!;
  };
  return { asked, bridge, poll, personReplies, thread, row, pass: (ms: number) => void (now += ms) };
}

const GONE_MS = INBOX_ASKER_RESTART_GRACE_MS + INBOX_SESSION_LIVE_MS + 1;

describe("a reply after the conversation moved to a new session id", () => {
  test("the continuing session is handed it without writing in the thread first, with the words the old session would get, and once", async () => {
    const { asked, bridge, poll, personReplies, thread, row, pass } = await world();
    expect(await poll("ses-old")).toEqual([]);
    pass(GONE_MS);
    expect((await row()).session_ended).toBe(true);
    const reply = await personReplies("Use the ARM runner.");

    // A session that does not say it continues the old one gets nothing.
    expect(await poll("ses-other")).toEqual([]);
    const commands = await poll("ses-new", ["ses-old"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "reply", id: reply.id, thread_id: asked.thread_id, reply_to: asked.message_id });
    // Not a reply moved to another session: the conversation is the same one.
    expect(commands[0]!.redirected_from).toBeUndefined();
    expect(commands[0]!.tagged).toBeUndefined();
    expect(inboxWakeText(commands[0]!)).toContain("Use the ARM runner.");
    // The thread's conversation goes on: the row no longer says it ended.
    expect((await row()).session_ended).toBeUndefined();

    const delivered = await bridge(INBOX_BRIDGE_EVENT_PATH, { session: "ses-new", host: "claude-code", type: "delivered", id: reply.id });
    expect(delivered.status).toBe(200);
    expect((await thread()).messages.at(-1)?.delivery).toMatchObject({ state: "delivered", host: "claude-code" });
    expect(await poll("ses-new", ["ses-old"])).toEqual([]);
    // A session that names nothing still may not acknowledge another session's reply.
    const next = await personReplies("And keep x86 for the release build.");
    const wrong = await bridge(INBOX_BRIDGE_EVENT_PATH, { session: "ses-other", host: "claude-code", type: "delivered", id: next.id });
    expect(wrong.status).toBe(422);
    expect((await poll("ses-new", ["ses-old"])).map((command) => command.id)).toEqual([next.id]);
  });

  test("the old session still polling keeps its replies: the branch gets nothing until it is gone", async () => {
    const { bridge, poll, personReplies, pass } = await world();
    await poll("ses-old");
    const reply = await personReplies("Use the ARM runner.");
    expect(await poll("ses-new", ["ses-old"])).toEqual([]);
    // The branch may not take it either.
    const early = await bridge(INBOX_BRIDGE_EVENT_PATH, { session: "ses-new", host: "claude-code", type: "delivered", id: reply.id });
    expect(early.status).toBe(422);
    expect((await poll("ses-old")).map((command) => command.id)).toEqual([reply.id]);

    pass(INBOX_SESSION_LIVE_MS + 1);
    expect((await poll("ses-new", ["ses-old"])).map((command) => command.id)).toEqual([reply.id]);
  });
});
