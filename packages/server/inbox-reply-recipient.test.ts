/**
 * The reply recipient pill's server items (approval "inbox-reply-recipient",
 * reply-recipient-options.md "Server changes" 1, 3 and 4):
 *
 * 1. A reply draft remembers who it goes to (`recipients`), so the pill comes
 *    back aimed after a reload, in another window or on leaving the thread.
 * 3. An agent that answers from another folder (`reply_to` into another
 *    project's thread) keeps its own project on the message (`from_project`),
 *    so the window still names it "in plannotator" after its session ends.
 * 4. A live session that wrote in the thread is one of its live sessions from
 *    any folder: listed for the pill, and a reply may go to it alone (`to`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxReplyDraft, InboxThread } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reply-recipient-")));
  roots.push(root);
  const billing = join(root, "billing-api");
  const plannotator = join(root, "plannotator");
  mkdirSync(billing, { recursive: true });
  mkdirSync(plannotator, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-reply-recipient-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, billing, plannotator };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function claudeSends(client: Client, project: string, session: string, body: string, replyTo?: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_host: "claude-code", agent_name: "Claude Code", agent_session: session, ...(replyTo ? { reply_to: replyTo } : {}) },
    _meta: { [INBOX_WAKES_META_KEY]: true },
  });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as { message_id: string; thread_id: string };
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

async function saveDraft(server: InboxServer, threadId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base(server)}/api/inbox/threads/${threadId}/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, files_add: [], files_remove: [], files_place: [], ...body }),
  });
}

async function readDraft(server: InboxServer, threadId: string): Promise<InboxReplyDraft | null> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}/draft`)).json()) as { draft: InboxReplyDraft | null }).draft;
}

/** A session's connection polls once: it is live for the next 30 s. */
async function polls(server: InboxServer, session: string, project: string): Promise<void> {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", project_path: project, waitMs: 0, tags: true }),
  });
  expect(response.status).toBe(200);
}

describe("a reply draft remembers who it goes to", () => {
  test("a save names the recipients; a save without them keeps them; an empty list clears them; a malformed list is refused", async () => {
    const { server, client, billing } = await setup();
    const asked = await claudeSends(client, billing, "ses-a", "Ship the PDF export?");

    const first = await saveDraft(server, asked.thread_id, { body: "Ship it", base: null, recipients: ["ses-b", "ses-a"] });
    expect(first.status).toBe(200);
    const saved = ((await first.json()) as { draft: InboxReplyDraft }).draft;
    expect(saved.recipients).toEqual(["ses-b", "ses-a"]);

    // An older page (or a host that does not send them): the words change, the recipients stay.
    const words = ((await (await saveDraft(server, asked.thread_id, { body: "Ship it today", base: saved.updated_at })).json()) as { draft: InboxReplyDraft }).draft;
    expect(words.recipients).toEqual(["ses-b", "ses-a"]);
    expect((await readDraft(server, asked.thread_id))?.recipients).toEqual(["ses-b", "ses-a"]);

    const cleared = ((await (await saveDraft(server, asked.thread_id, { body: "Ship it today", base: words.updated_at, recipients: [] })).json()) as { draft: InboxReplyDraft }).draft;
    expect(cleared.recipients).toBeUndefined();

    const twice = await saveDraft(server, asked.thread_id, { body: "x", base: cleared.updated_at, recipients: ["ses-a", "ses-a"] });
    expect(twice.status).toBe(422);
    const many = await saveDraft(server, asked.thread_id, { body: "x", base: cleared.updated_at, recipients: Array.from({ length: 10 }, (_, i) => `ses-${i}`) });
    expect(many.status).toBe(422);
    // Only session ids as a tag names them: a path, a space or a line break is refused.
    for (const id of ["../ses-a", "ses a", "ses-a\nx", ""]) {
      const odd = await saveDraft(server, asked.thread_id, { body: "x", base: cleared.updated_at, recipients: [id] });
      expect(odd.status).toBe(422);
    }
    expect((await readDraft(server, asked.thread_id))?.body).toBe("Ship it today");
  });
});

describe("an agent answering from another folder keeps its project", () => {
  test("a reply_to from another project's folder records it; a send from the thread's own project does not", async () => {
    const { server, client, billing, plannotator } = await setup();
    const started = await claudeSends(client, billing, "ses-a", "The invoice PDF export is in.");
    const fromThere = await claudeSends(client, plannotator, "ses-b", "I moved the template into the shared renderer.", started.message_id);
    const fromHere = await claudeSends(client, billing, "ses-c", "Totals match.", started.message_id);

    const messages = (await thread(server, started.thread_id)).messages;
    expect(messages.find((m) => m.id === fromThere.message_id)?.from_project).toEqual({ name: "plannotator", root: plannotator });
    expect(messages.find((m) => m.id === fromHere.message_id)?.from_project).toBeUndefined();
    expect(messages.find((m) => m.id === started.message_id)?.from_project).toBeUndefined();

    // An agent reading the thread's full records gets the folder's name only, never the other folder's absolute path.
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id: started.thread_id, agent_session: "ses-c", format: "full" } });
    expect(read.isError).toBeFalsy();
    const seen = JSON.stringify(read);
    expect(seen).not.toContain(plannotator);
    expect(seen).toContain('"from_project":{"name":"plannotator"}');
  });
});

describe("a live writer from another folder is one of the thread's live sessions", () => {
  test("listed by the sessions route, and a reply may be sent to it alone", async () => {
    const { server, client, billing, plannotator } = await setup();
    const started = await claudeSends(client, billing, "ses-a", "Should the PDF show the new totals?");
    await claudeSends(client, plannotator, "ses-b", "The docs build picks up the shared renderer.", started.message_id);
    // ses-b's connection polls from its own folder; ses-c is live in that folder too but never wrote here.
    await polls(server, "ses-b", plannotator);
    await polls(server, "ses-c", plannotator);

    const sessions = (await (await fetch(`${base(server)}/api/inbox/threads/${started.thread_id}/sessions`)).json()) as { sessions: { session: string }[] };
    const listed = sessions.sessions.map((s) => s.session);
    expect(listed).toContain("ses-b");
    expect(listed).not.toContain("ses-c");

    // The person sends the answer to ses-a's question to ses-b alone.
    const reply = await fetch(`${base(server)}/api/inbox/messages/${started.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "k-to-b", words: "New totals now.", to: { host: "claude-code", session: "ses-b" } }),
    });
    expect(reply.status).toBe(200);
    const written = ((await reply.json()) as { reply: { to?: { session: string } } }).reply;
    expect(written.to?.session).toBe("ses-b");

    // A live session from another folder that is not in the thread is still refused.
    const refused = await fetch(`${base(server)}/api/inbox/messages/${started.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "k-to-c", words: "Also you.", to: { host: "claude-code", session: "ses-c" } }),
    });
    expect(refused.status).toBe(409);
  });
});
