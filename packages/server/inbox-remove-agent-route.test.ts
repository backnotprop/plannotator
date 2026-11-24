/**
 * Remove an agent from a thread over HTTP (approval "inbox-remove-agent-from-thread"): `POST
 * /api/inbox/threads/:id/remove-agent` and its Undo, on a running Inbox with real MCP agents. The removed agent is out
 * of the thread's owner (the session the person's plain reply goes to), its own post lands and carries the one line,
 * the last agent is refused, and Undo puts it back.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_REMOVED_FROM_THREAD_TEXT } from "./inbox-mcp";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const API = "cc-billing-api";
const HOOKS = "cc-webhooks";

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-remove-agent-route-")));
  roots.push(root);
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-remove-agent-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function agentSends(client: Client, project: string, session: string, body: string, extra: Record<string, unknown> = {}) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", ...extra },
    _meta: { [INBOX_WAKES_META_KEY]: true },
  });
  const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  return { ...(result.structuredContent as { message_id: string; thread_id: string }), text };
}

async function poll(server: InboxServer, session: string, project: string) {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", project_path: project, waitMs: 0, tags: true }),
  });
  expect(response.status).toBe(200);
}

async function post(server: InboxServer, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

async function owner(server: InboxServer, threadId: string): Promise<string | null> {
  const model = (await (await fetch(`${base(server)}/api/inbox/threads/${threadId}/taggable`)).json()) as { owner: { session: string } | null };
  return model.owner?.session ?? null;
}

test("remove, the removed agent's own post, the last agent refused, and Undo", async () => {
  const { server, client, project } = await setup();
  await poll(server, API, project);
  await poll(server, HOOKS, project);
  const asked = await agentSends(client, project, API, "Stripe answers 409 on refunds with a reused key.", { subject: "Stripe 409s" });
  const tag = await post(server, `/api/inbox/messages/${asked.message_id}/reply`, {
    idempotency_key: "tag",
    words: "@Claude Code check the webhook side.",
    tags: [{ host: "claude-code", session: HOOKS, label: "Claude Code (webhooks)" }],
  });
  expect(tag.status).toBe(200);
  const hooks = await agentSends(client, project, HOOKS, "The webhook retries reuse the old key.", { reply_to: asked.message_id });
  expect(hooks.text).not.toContain(INBOX_REMOVED_FROM_THREAD_TEXT);
  const threadId = asked.thread_id;
  expect(await owner(server, threadId)).toBe(HOOKS);

  const removed = await post(server, `/api/inbox/threads/${threadId}/remove-agent`, { session: HOOKS });
  expect(removed.status).toBe(200);
  expect((removed.json.removal as { session: string }).session).toBe(HOOKS);
  expect((await thread(server, threadId)).messages[0]!.removed?.map((r) => r.session)).toEqual([HOOKS]);
  expect(await owner(server, threadId)).toBe(API);

  // The last agent stays; one that is not in the thread is no one to remove; no session is a bad request.
  expect((await post(server, `/api/inbox/threads/${threadId}/remove-agent`, { session: API })).json.code).toBe("last_agent");
  expect((await post(server, `/api/inbox/threads/${threadId}/remove-agent`, { session: "cc-stranger" })).json.code).toBe("not_in_thread");
  expect((await post(server, `/api/inbox/threads/${threadId}/remove-agent`, {})).json.code).toBe("validation_error");

  // Its own post lands, carries the line, and it stays out.
  const again = await agentSends(client, project, HOOKS, "Replays are done.", { reply_to: asked.message_id });
  expect(again.thread_id).toBe(threadId);
  expect(again.text).toContain(INBOX_REMOVED_FROM_THREAD_TEXT);
  expect(await owner(server, threadId)).toBe(API);

  // Undo: as it was, and the thread is with the agent that wrote last again.
  const undone = await post(server, `/api/inbox/threads/${threadId}/remove-agent/undo`, { session: HOOKS });
  expect(undone.status).toBe(200);
  expect(undone.json.removed).toEqual([]);
  expect((await thread(server, threadId)).messages[0]!.removed ?? null).toBeNull();
  expect(await owner(server, threadId)).toBe(HOOKS);
});
