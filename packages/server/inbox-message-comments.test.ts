/**
 * Comments on the text of an agent's message in the Plannotator Inbox
 * (approval "inbox-message-comments", 2026-10-19), proved through the
 * server's real doors: a running Inbox on loopback, the MCP SDK client over
 * streamable HTTP for the agent (send_message, read_thread), and real
 * `fetch` for the window. Every test has its own temp data dir. The window
 * side (select, comment, the chip, Send) is proved in
 * packages/inbox/messageComments.test.tsx and tests/e2e/inbox-message-comments.spec.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAnnotationRecord } from "@plannotator/core/inbox-types";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { attachmentFeedback } from "../inbox/attachments";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-message-comments-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "notes.md"), "# Notes\n\nShip on Friday.\n");
  return { root, project, dataDir: join(root, "data") };
}

async function start(dataDir: string): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-message-comments-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

function post(server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function pending(server: InboxServer, threadId: string): Promise<InboxAnnotationRecord[]> {
  const model = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}/attachments`)).json()) as { annotations: InboxAnnotationRecord[] };
  return model.annotations;
}

const BODY = "I moved the retry loop into the client.\n\nThe backoff is now 2, 4 and 8 seconds, and a 429 waits for Retry-After.";

/** A comment on selected words, as the window's viewer makes it (Plannotator's text-selection annotation). */
function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: "ann-msg-1",
    blockId: "block-1",
    startOffset: 15,
    endOffset: 34,
    type: "COMMENT",
    text: "Cap the total wait too.",
    originalText: "2, 4 and 8 seconds",
    createdA: 1,
    ...overrides,
  };
}

async function sendMessage(client: Client, project: string, extra: Record<string, unknown> = {}) {
  return call(client, "send_message", { project_path: project, body: BODY, agent_session: "ses_retry", agent_name: "Claude Code", agent_host: "claude-code", ...extra });
}

test("a comment on an agent's message is kept with the thread's annotations, edits in place, and is removed", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await sendMessage(client, project);
  const route = `/api/inbox/messages/${sent.message_id}/annotations`;

  const saved = await post(server, route, { annotation: comment() });
  expect(saved.status).toBe(200);
  const record = ((await saved.json()) as { annotation: InboxAnnotationRecord }).annotation;
  expect(record).toMatchObject({
    message_id: sent.message_id,
    thread_id: sent.thread_id,
    attachment_id: "",
    path: sent.message_id,
    version: "current",
    sent_reply_id: null,
  });
  // The message's own time rides the record, so a reader names the message without looking it up.
  const thread = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: { messages: { id: string; created_at: string }[] } };
  expect(record.message).toEqual({ at: thread.thread.messages[0]!.created_at });
  expect(record.annotation.originalText).toBe("2, 4 and 8 seconds");
  expect(await pending(server, sent.thread_id)).toHaveLength(1);

  // An edit (same id) replaces the text and keeps when it was made.
  const edited = await post(server, route, { annotation: comment({ text: "Cap the total wait at 30 seconds." }) });
  expect(edited.status).toBe(200);
  const after = ((await edited.json()) as { annotation: InboxAnnotationRecord }).annotation;
  expect(after.annotation.text).toBe("Cap the total wait at 30 seconds.");
  expect(after.created_at).toBe(record.created_at);

  // Kept on disk as an additive annotation line.
  const projectDir = join(dataDir, "inbox", "projects", readdirSync(join(dataDir, "inbox", "projects"))[0]!);
  const lines = readFileSync(join(projectDir, "annotations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map((line) => line.kind)).toEqual(["annotation", "annotation"]);
  expect(lines[1].record.message.at).toBe(record.message!.at);

  // A restart reads it back.
  server.stop();
  servers.splice(servers.indexOf(server), 1);
  const again = await start(dataDir);
  expect((await pending(again, sent.thread_id)).map((r) => [r.id, r.annotation.text])).toEqual([["ann-msg-1", "Cap the total wait at 30 seconds."]]);

  // Removed: no longer pending, and closed to edits.
  expect((await post(again, "/api/inbox/annotations/ann-msg-1/remove", {})).status).toBe(200);
  expect(await pending(again, sent.thread_id)).toHaveLength(0);
  const reopen = await post(again, route, { annotation: comment() });
  expect(reopen.status).toBe(409);
  expect(((await reopen.json()) as { code: string }).code).toBe("annotation_closed");
});

test("refused: the person's own message, an unknown message, a deletion or empty quote, an id used on a file, another site and a stale tab", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await sendMessage(client, project, { attachments: ["notes.md"] });
  const route = `/api/inbox/messages/${sent.message_id}/annotations`;
  const refused = async (path: string, annotation: unknown, status: number, code: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
    const answer = await post(server, path, { annotation, ...extra }, headers);
    expect([path, answer.status, ((await answer.json()) as { code: string }).code]).toEqual([path, status, code]);
  };

  await refused(route, comment({ type: "DELETION" }), 422, "validation_error");
  await refused(route, comment({ type: "GLOBAL_COMMENT" }), 422, "validation_error");
  await refused(route, comment({ originalText: "   " }), 422, "validation_error");
  await refused(route, comment({ originalText: "x".repeat(20_001) }), 422, "validation_error");
  await refused(route, comment({ id: "has a space" }), 422, "validation_error");
  await refused(route, comment({ text: 4 }), 422, "validation_error");
  // A comment has words, at most 10,000 characters (so the agent never reads `> undefined`).
  await refused(route, comment({ text: undefined }), 422, "validation_error");
  await refused(route, comment({ text: "  " }), 422, "validation_error");
  await refused(route, comment({ text: "x".repeat(10_001) }), 422, "validation_error");
  expect((await post(server, route, { annotation: comment({ id: "ann-long", text: "x".repeat(10_000) }) })).status).toBe(200);
  expect((await post(server, "/api/inbox/annotations/ann-long/remove", {})).status).toBe(200);
  // Words only: no images, element, page or reply thread.
  await refused(route, comment({ images: [{ path: "/tmp/a.png", name: "a" }] }), 422, "validation_error");
  await refused(route, comment({ elementContext: { tag: "div" } }), 422, "validation_error");
  await refused(route, comment({ pageUrl: "/admin" }), 422, "validation_error");
  await refused(route, comment({ inReplyTo: "ann-other" }), 422, "validation_error");
  await refused(route, [comment()], 422, "validation_error");
  await refused("/api/inbox/messages/msg_00000000000000000000000000/annotations", comment(), 404, "message_not_found");
  await refused(route, comment(), 403, "cross_origin", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
  await refused(route, comment(), 409, "session_mismatch", {}, { serverSession: "an-older-inbox" });
  // GET is not a door.
  expect((await fetch(`http://127.0.0.1:${server.port}${route}`)).status).toBe(405);

  // The person's own reply takes no comments.
  const reply = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "r-1", words: "Looks right." });
  expect(reply.status).toBe(200);
  const mine = ((await reply.json()) as { reply: { id: string } }).reply.id;
  await refused(`/api/inbox/messages/${mine}/annotations`, comment({ id: "ann-mine" }), 422, "annotation_not_allowed");
  expect(await pending(server, sent.thread_id)).toHaveLength(0);

  // A message comment's id is not a file annotation's, nor the other way round.
  expect((await post(server, route, { annotation: comment() })).status).toBe(200);
  const viaFile = await post(server, "/api/inbox/annotations", { attachment_id: sent.attachments[0].id, version: "current", annotation: { id: "ann-msg-1", text: "x" } });
  expect(viaFile.status).toBe(422);
  expect((await post(server, "/api/inbox/annotations", { attachment_id: sent.attachments[0].id, version: "current", annotation: { id: "ann-file-1", text: "x" } })).status).toBe(200);
  await refused(route, comment({ id: "ann-file-1" }), 422, "validation_error");
  // Nor one on another message of the thread.
  const later = await sendMessage(client, project, { reply_to: sent.message_id, body: "Also: the jitter." });
  await refused(`/api/inbox/messages/${later.message_id}/annotations`, comment(), 422, "validation_error");
});

test("an archived thread's messages take no new comment and no edit (409) until it is unarchived", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await sendMessage(client, project);
  const route = `/api/inbox/messages/${sent.message_id}/annotations`;
  expect((await post(server, route, { annotation: comment() })).status).toBe(200);
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/resolve`, { resolved: true })).status).toBe(200);
  for (const annotation of [comment({ id: "ann-msg-new" }), comment({ text: "An edit." })]) {
    const answer = await post(server, route, { annotation });
    expect(answer.status).toBe(409);
    expect(((await answer.json()) as { code: string }).code).toBe("thread_resolved");
  }
  // An agent's message after the archive line behaves as an open thread's: it takes comments.
  const back = await sendMessage(client, project, { reply_to: sent.message_id, body: "One more thing: the retry budget." });
  expect((await post(server, `/api/inbox/messages/${back.message_id}/annotations`, { annotation: comment({ id: "ann-back", originalText: "retry budget" }) })).status).toBe(200);
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/resolve`, { resolved: false })).status).toBe(200);
  expect((await post(server, route, { annotation: comment({ text: "An edit." }) })).status).toBe(200);
});

/** A comment on a diagram part in a message, as DiagramBlock makes it. */
function diagramComment(overrides: Record<string, unknown> = {}) {
  return comment({
    id: "ann-diagram-1",
    blockId: "block-1",
    startOffset: 0,
    endOffset: 0,
    text: "Run the integration suite here too.",
    originalText: "Tests pass?",
    diagramAnchor: { v: 1, family: "flowchart", kind: "node", id: "B", label: "Tests pass?", sourceLine: [5, 5] },
    ...overrides,
  });
}

test("a comment on a diagram part keeps its anchor through the door, an edit and a restart, and Send names the part; a malformed anchor is refused", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await sendMessage(client, project);
  const route = `/api/inbox/messages/${sent.message_id}/annotations`;

  for (const diagramAnchor of [null, "node B", { v: 2, family: "flowchart", kind: "node", id: "B" }, { v: 1, family: "plantuml", kind: "node", id: "B" }, { v: 1, family: "flowchart", kind: "edge", from: "B" }]) {
    const answer = await post(server, route, { annotation: diagramComment({ diagramAnchor }) });
    expect([answer.status, ((await answer.json()) as { code: string }).code]).toEqual([422, "validation_error"]);
  }
  expect(await pending(server, sent.thread_id)).toHaveLength(0);

  // What is stored is the anchor as the parser reads it: anything else a client put beside it stays out.
  const anchor = { v: 1, family: "flowchart", kind: "node", id: "B", label: "Tests pass?", sourceLine: [5, 5] };
  expect((await post(server, route, { annotation: diagramComment({ diagramAnchor: { ...anchor, extra: "<script>" } }) })).status).toBe(200);
  expect((await post(server, route, { annotation: diagramComment({ text: "Run it nightly too." }) })).status).toBe(200);
  server.stop();
  servers.splice(servers.indexOf(server), 1);
  const again = await start(dataDir);
  const records = await pending(again, sent.thread_id);
  expect(records.map((r) => [r.annotation.text, r.annotation.diagramAnchor])).toEqual([["Run it nightly too.", anchor]]);

  const reply = await post(again, `/api/inbox/messages/${sent.message_id}/reply`, {
    idempotency_key: "send-diagram",
    words: "One note on the diagram.",
    feedback: attachmentFeedback(records, [], new Map(), project),
    annotation_ids: records.map((r) => r.id),
  });
  expect(reply.status).toBe(200);
  const body = ((await reply.json()) as { reply: { body: string } }).reply.body;
  expect(body).toContain('Feedback on: "Tests pass?"\nDiagram node Tests pass? (B), line 5\n\n> Run it nightly too.');
  expect(await pending(again, sent.thread_id)).toHaveLength(0);
});

test("over the tailnet a comment on a diagram part goes as a comment on words does, the owner's and an allowed guest's; another site's is refused the same", async () => {
  const MAGIC = "macbook-pro.tail0000.ts.net";
  const OWNER = "ramos@example.com";
  const GUEST = "guest@example.com";
  const serve = new Map<number, string>();
  const fakeTailscale: TailscaleRunner = (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
    if (args[1] === "status") {
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(serve.size === 0 ? "{}" : JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`https://${MAGIC}:${httpsPort}/\n`);
  };
  const { project, dataDir } = world();
  mkdirSync(dataDir, { recursive: true });
  // The tailnet's allowed logins come from config.json in the data dir (loadConfig reads the env's).
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscaleAllow: [GUEST] }));
  const previous = { data: process.env.PLANNOTATOR_DATA_DIR, ts: process.env.PLANNOTATOR_INBOX_TAILSCALE };
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  try {
    const server = await startInboxServer({ dataDir, binaryPath: null, tailscale: fakeTailscale, publishTailnet: true, phones: false });
    servers.push(server);
    const client = await agent(server);
    const sent = await sendMessage(client, project);
    const listener = server.tailscale.listenerPort();
    expect(listener).not.toBeNull();
    const origin = `https://${MAGIC}:${server.port}`;
    const through = (login: string, annotation: unknown, site: string = origin) =>
      fetch(`http://127.0.0.1:${listener}/api/inbox/messages/${sent.message_id}/annotations`, {
        method: "POST",
        headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login, Origin: site, "Sec-Fetch-Site": site === origin ? "same-origin" : "cross-site", "Content-Type": "application/json" },
        body: JSON.stringify({ serverSession: server.serverSession, annotation }),
      });
    const codes: [string, number][] = [];
    for (const [login, words, diagram] of [
      [OWNER, comment({ id: "ann-owner-words" }), diagramComment({ id: "ann-owner-part" })],
      [GUEST, comment({ id: "ann-guest-words" }), diagramComment({ id: "ann-guest-part" })],
    ] as const) {
      codes.push([login, (await through(login, words)).status], [login, (await through(login, diagram)).status]);
    }
    expect(codes).toEqual([[OWNER, 200], [OWNER, 200], [GUEST, 200], [GUEST, 200]]);
    expect((await through(OWNER, diagramComment({ id: "ann-evil" }), "https://evil.example")).status).toBe((await through(OWNER, comment({ id: "ann-evil-2" }), "https://evil.example")).status);
    expect((await pending(server, sent.thread_id)).filter((r) => r.annotation.diagramAnchor).map((r) => r.id).sort()).toEqual(["ann-guest-part", "ann-owner-part"]);
  } finally {
    if (previous.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = previous.data;
    if (previous.ts !== undefined) process.env.PLANNOTATOR_INBOX_TAILSCALE = previous.ts;
  }
});

test("Send carries the comments quoted under 'Feedback on your message from <time>', before the files'; the agent's read_thread returns it, and a sent comment is closed", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await sendMessage(client, project, { attachments: ["notes.md"] });
  const route = `/api/inbox/messages/${sent.message_id}/annotations`;
  expect((await post(server, route, { annotation: comment() })).status).toBe(200);
  expect((await post(server, route, { annotation: comment({ id: "ann-msg-2", originalText: "I moved the retry loop into the client.\n\nThe backoff is now", text: "Good.", blockId: "block-0", startOffset: 0 }) })).status).toBe(200);
  // A file comment too: both ride the same Send.
  expect(
    (
      await post(server, "/api/inbox/annotations", {
        attachment_id: sent.attachments[0].id,
        version: "current",
        annotation: { id: "ann-file", blockId: "block-1", startOffset: 0, endOffset: 4, type: "COMMENT", text: "Make it Thursday.", originalText: "Ship on Friday.", createdA: 2 },
      })
    ).status,
  ).toBe(200);
  const records = await pending(server, sent.thread_id);
  expect(records).toHaveLength(3);

  // The window builds the feedback text exactly as on Send (packages/inbox/attachments.ts).
  const feedback = attachmentFeedback(records, [], new Map(), project);
  const reply = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, {
    idempotency_key: "send-1",
    words: "Two notes on your message.",
    feedback,
    annotation_ids: records.map((r) => r.id),
  });
  expect(reply.status).toBe(200);
  const body = ((await reply.json()) as { reply: { body: string } }).reply.body;
  const at = (part: string) => body.indexOf(part);
  expect(at("Two notes on your message.")).toBeLessThan(at("# Feedback on your messages"));
  expect(at("# Feedback on your messages")).toBeLessThan(at("# Feedback on the attached files"));
  for (const part of [
    `## Feedback on your message from `,
    `(${sent.message_id})`,
    "I've reviewed this message and have 2 pieces of feedback:",
    'Feedback on: "2, 4 and 8 seconds"',
    "> Cap the total wait too.",
    // Words across paragraphs: fenced under the heading, so nothing in them reads as markdown.
    "### 1. Feedback on:\n```\nI moved the retry loop into the client.\n\nThe backoff is now\n```\n> Good.",
    '### 2. Feedback on: "2, 4 and 8 seconds"',
    "Make it Thursday.",
  ]) {
    expect(body).toContain(part);
  }

  // Sent: no longer pending, closed to edits and removal.
  expect(await pending(server, sent.thread_id)).toHaveLength(0);
  expect((await post(server, route, { annotation: comment({ text: "late" }) })).status).toBe(409);
  expect((await post(server, "/api/inbox/annotations/ann-msg-1/remove", {})).status).toBe(409);

  // The agent that wrote the message reads the reply with the quotes and comments.
  const answer = await call(client, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_retry", format: "full" });
  const text = JSON.stringify(answer);
  expect(text).toContain("2, 4 and 8 seconds");
  expect(text).toContain("Cap the total wait too.");
  expect(text).toContain(sent.message_id);
});
