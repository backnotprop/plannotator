import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAgent, InboxListRow } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_OFF_POLL_FIELD, INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-session-off-")));
  roots.push(root);
  const project = join(root, "harbor");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-session-off-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base(server)}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const bridge = (server: InboxServer, path: string, body: unknown) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });

async function list(server: InboxServer) {
  return (await (await fetch(`${base(server)}/api/inbox/threads?archived=exclude`)).json()) as { sections: { threads: InboxListRow[] }[]; agents: { agents: InboxAgent[] }[] };
}

const rowOf = async (server: InboxServer, threadId: string) => (await list(server)).sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
const agentOf = async (server: InboxServer, session: string) => (await list(server)).agents.flatMap((g) => g.agents).find((a) => a.session === session);

describe("a session with its Inbox turned off", () => {
  test("its connection says off: the reply waits as Inbox off on the row, the thread and the Agents card; on, it is sent", async () => {
    const { server, client, project } = await setup();
    const sent = (
      await client.callTool({
        name: "send_message",
        arguments: { body: "The harbor build is green. Merge?", project_path: project, agent_session: "ses-off", agent_host: "claude-code" },
        _meta: { [INBOX_WAKES_META_KEY]: true },
      })
    ).structuredContent as { message_id: string; thread_id: string };
    const poll = (extra: Record<string, unknown>) => bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-off", host: "claude-code", project_path: project, waitMs: 0, busy: false, ...extra });
    await poll({ [INBOX_OFF_POLL_FIELD]: true });
    const replied = await fetch(`${base(server)}/api/inbox/messages/${sent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "k-off", words: "Yes, after Bob Tully signs off." }),
    });
    expect(replied.status).toBeLessThan(300);

    expect((await rowOf(server, sent.thread_id)).delivery).toMatchObject({ state: "queued", reason: "inbox_off" });
    const connection = async () =>
      ((await (await fetch(`${base(server)}/api/inbox/threads/${sent.thread_id}/sessions?asker=ses-off`)).json()) as { asker: { connection: { inbox_off?: boolean } } }).asker.connection;
    expect((await connection()).inbox_off).toBe(true);
    expect((await agentOf(server, "ses-off"))?.inbox_off).toBe(true);

    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-off", host: "claude-code", type: "state", busy: false, [INBOX_OFF_POLL_FIELD]: false });
    expect((await rowOf(server, sent.thread_id)).delivery).toMatchObject({ state: "sending" });
    expect((await connection()).inbox_off).toBeUndefined();
    expect((await agentOf(server, "ses-off"))?.inbox_off).toBeUndefined();
  }, 20_000);

  test("a Part 1 host whose poll lacks the field reads as too old to turn off; a host outside Part 1 does not", async () => {
    const { server, project } = await setup();
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-old", host: "pi", project_path: project, waitMs: 0, busy: false });
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-new", host: "pi", project_path: project, waitMs: 0, busy: false, [INBOX_OFF_POLL_FIELD]: false });
    await bridge(server, INBOX_BRIDGE_POLL_PATH, { session: "ses-codex", host: "codex", project_path: project, waitMs: 0, busy: false });
    expect((await agentOf(server, "ses-old"))?.inbox_off_unknown).toBe(true);
    expect((await agentOf(server, "ses-new"))?.inbox_off_unknown).toBeUndefined();
    expect((await agentOf(server, "ses-codex"))?.inbox_off_unknown).toBeUndefined();
  }, 20_000);
});
