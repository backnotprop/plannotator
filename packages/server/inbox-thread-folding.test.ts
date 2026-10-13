/**
 * The facts the window folds a thread by (design record "Land", not in this
 * repo), through the server's real doors: a running Inbox on loopback, the
 * MCP SDK client for the agent, real `fetch` for the window. The window's
 * thread (`GET /api/inbox/threads/:id`) carries each message's `seq` and, on
 * a person's reply, how many annotations it carried; what is new since the
 * last look is read from it BEFORE `/seen` is recorded. The MCP tools return
 * the thread unchanged. The window's side is proved in
 * packages/inbox/folding.test.tsx and tests/e2e/inbox-thread-folding.spec.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-folding-")));
  roots.push(root);
  const project = join(root, "docs-site");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "plan.md"), "# Plan\n\nBuild the index at deploy.\n");
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-folding-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { project, server, client };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

function post(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function windowThread(server: InboxServer, threadId: string): Promise<InboxThread> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { thread: InboxThread }).thread;
}

test("the window's thread carries each message's seq: the event-log seq it was sent at, in thread order", async () => {
  const { project, server, client } = await world();
  const first = await call(client, "send_message", { project_path: project, body: "I looked at three ways to add search.", agent_session: "ses_A" });
  const second = await call(client, "send_message", { project_path: project, body: "Pushed the fix.", agent_session: "ses_A" });
  const thread = await windowThread(server, first.thread_id);
  expect(thread.messages.map((m) => m.seq)).toEqual([first.cursor, second.cursor]);
  expect(thread.messages[1]!.seq!).toBeGreaterThan(thread.messages[0]!.seq!);
  // A later write to the root (a look) does not change the root's seq: it is the first line's.
  expect((await post(server, `/api/inbox/threads/${first.thread_id}/seen`, {})).status).toBe(200);
  expect((await windowThread(server, first.thread_id)).messages[0]!.seq).toBe(first.cursor);
});

test("read before the look, the payload tells which agent messages are new; after /seen, none are", async () => {
  const { project, server, client } = await world();
  const first = await call(client, "send_message", { project_path: project, body: "Two calls before I start.", agent_session: "ses_A" });
  // The person looks, then replies: everything before the reply is read.
  expect((await post(server, `/api/inbox/threads/${first.thread_id}/seen`, {})).status).toBe(200);
  const reply = await post(server, `/api/inbox/messages/${first.message_id}/reply`, { idempotency_key: "k1", words: "Pagefind is fine." });
  expect(reply.status).toBe(200);
  const later = await call(client, "send_message", { project_path: project, body: "CI is green.", agent_session: "ses_A" });

  const before = await windowThread(server, first.thread_id);
  const root = before.messages[0]!;
  const lastPerson = before.messages.filter((m) => m.author.kind === "person").at(-1)!;
  const boundary = Math.max(root.person_seen_seq ?? 0, lastPerson.seq!);
  const fresh = before.messages.filter((m) => m.author.kind === "agent" && m.seq! > boundary).map((m) => m.id);
  expect(fresh).toEqual([later.message_id]);

  expect((await post(server, `/api/inbox/threads/${first.thread_id}/seen`, {})).status).toBe(200);
  const after = await windowThread(server, first.thread_id);
  expect(after.messages[0]!.person_seen_seq).toBe(later.cursor);
  expect(after.messages.filter((m) => m.author.kind === "agent" && m.seq! > after.messages[0]!.person_seen_seq!)).toEqual([]);
});

test("a person's reply says how many annotations it carried; an agent message carries no such field", async () => {
  const { project, server, client } = await world();
  const sent = await call(client, "send_message", { project_path: project, body: "The plan, for a look.", attachments: ["plan.md"], agent_session: "ses_A" });
  const attachmentId = sent.attachments[0].id as string;
  for (const id of ["ann-1", "ann-2"]) {
    const saved = await post(server, "/api/inbox/annotations", {
      attachment_id: attachmentId,
      version: "current",
      annotation: { id, type: "COMMENT", text: "Why?", originalText: "Build the index at deploy.", blockId: "block-1", startOffset: 0, endOffset: 0, createdA: 1 },
    });
    expect(saved.status).toBe(200);
  }
  const withNotes = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, {
    idempotency_key: "k1",
    words: "Two notes.",
    feedback: "# Feedback on the attached files\n\nWhy?",
    annotation_ids: ["ann-1", "ann-2"],
  });
  expect(withNotes.status).toBe(200);
  const plain = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "k2", words: "And one more thing." });
  expect(plain.status).toBe(200);
  const thread = await windowThread(server, sent.thread_id);
  const [agentMessage, notes, words] = thread.messages;
  expect("sent_annotations" in agentMessage!).toBe(false);
  expect(notes!.sent_annotations).toBe(2);
  expect(words!.sent_annotations).toBe(0);
});

test("the MCP tools return the thread unchanged: no seq, no sent_annotations", async () => {
  const { project, client } = await world();
  const sent = await call(client, "send_message", { project_path: project, body: "Hello.", agent_session: "ses_A" });
  const read = await call(client, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_A" });
  const message = read.thread.messages[0] as Record<string, unknown>;
  expect("seq" in message).toBe(false);
  expect("sent_annotations" in message).toBe(false);
});
