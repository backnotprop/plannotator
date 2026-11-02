/**
 * Comments on a guided review's diffs in the Plannotator Inbox, proved through
 * the server's real doors: a running Inbox on loopback, the MCP SDK client
 * over streamable HTTP for the agent (submit_guide, read_thread), and real
 * `fetch` for the window. Every test has its own temp data dir. The browser
 * side (the guide reader's line comments, the panel, the chip, Send) is
 * proved in tests/e2e/inbox-guides.spec.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAnnotationRecord } from "@plannotator/core/inbox-types";
import { attachmentFeedback } from "../inbox/attachments";
import { GUIDE_BRIEF_EXAMPLE } from "./inbox-guides";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-guide-comments-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "notes.md"), "# Notes\n");
  return { root, project, dataDir: join(root, "data") };
}

async function start(dataDir: string): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-guide-comments-test", version: "1.0.0" });
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

/** A line comment as the guide reader makes it (the review app's CodeAnnotation). */
function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: "ann-guide-1",
    type: "comment",
    scope: "line",
    filePath: "src/auth.ts",
    lineStart: 1,
    lineEnd: 1,
    side: "new",
    text: "Refresh before it expires, not after.",
    selectedText: "new",
    createdAt: 1,
    ...overrides,
  };
}

async function sendGuide(client: Client, project: string) {
  return call(client, "submit_guide", { project_path: project, ...GUIDE_BRIEF_EXAMPLE, agent_session: "ses_guide", agent_name: "Pi", agent_host: "pi" });
}

test("a comment on a guide's diff is kept with the thread's annotations, edits in place, and is removed", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await sendGuide(client, project);

  const saved = await post(server, `/api/inbox/messages/${sent.message_id}/guide/annotations`, { annotation: comment() });
  expect(saved.status).toBe(200);
  const record = ((await saved.json()) as { annotation: InboxAnnotationRecord }).annotation;
  expect(record).toMatchObject({
    message_id: sent.message_id,
    thread_id: sent.thread_id,
    attachment_id: "",
    path: "src/auth.ts",
    version: sent.guide.sha256,
    guide: { title: "Token refresh", file: "src/auth.ts", side: "new", line_start: 1, line_end: 1 },
    sent_reply_id: null,
  });
  expect(await pending(server, sent.thread_id)).toHaveLength(1);

  // An edit (same id) replaces the text and keeps when it was made.
  const edited = await post(server, `/api/inbox/messages/${sent.message_id}/guide/annotations`, { annotation: comment({ text: "Refresh a minute early." }) });
  expect(edited.status).toBe(200);
  const after = ((await edited.json()) as { annotation: InboxAnnotationRecord }).annotation;
  expect(after.annotation.text).toBe("Refresh a minute early.");
  expect(after.created_at).toBe(record.created_at);
  expect(await pending(server, sent.thread_id)).toHaveLength(1);

  // Kept on disk as an additive annotation line.
  const projectDir = join(dataDir, "inbox", "projects", readdirSync(join(dataDir, "inbox", "projects"))[0]!);
  const lines = readFileSync(join(projectDir, "annotations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map((line) => line.kind)).toEqual(["annotation", "annotation"]);
  expect(lines[1].record.guide.file).toBe("src/auth.ts");

  // Removed: no longer pending, and closed to edits.
  expect((await post(server, `/api/inbox/annotations/ann-guide-1/remove`, {})).status).toBe(200);
  expect(await pending(server, sent.thread_id)).toHaveLength(0);
  const reopen = await post(server, `/api/inbox/messages/${sent.message_id}/guide/annotations`, { annotation: comment() });
  expect(reopen.status).toBe(409);
  expect(((await reopen.json()) as { code: string }).code).toBe("annotation_closed");
});

test("a comment is refused on a file not in the guide, a bad side or range, a message with no guide, another site and a stale tab", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await sendGuide(client, project);
  const plain = await call(client, "send_message", { project_path: project, body: "No guide here.", attachments: ["notes.md"], thread: "plain" });
  const route = `/api/inbox/messages/${sent.message_id}/guide/annotations`;
  const refused = async (path: string, annotation: unknown, status: number, code: string, headers: Record<string, string> = {}) => {
    const answer = await post(server, path, { annotation }, headers);
    expect(answer.status).toBe(status);
    expect(((await answer.json()) as { code: string }).code).toBe(code);
  };

  await refused(route, comment({ filePath: "src/nope.ts" }), 422, "validation_error");
  await refused(route, comment({ side: "both" }), 422, "validation_error");
  await refused(route, comment({ lineStart: 3, lineEnd: 2 }), 422, "validation_error");
  await refused(route, comment({ scope: "file" }), 422, "validation_error");
  // Lines the guide's patch does not show: the brief's src/auth.ts hunk is new line 1 only.
  const outside = await post(server, route, { annotation: comment({ lineStart: 9999, lineEnd: 100000 }) });
  expect(outside.status).toBe(422);
  expect(((await outside.json()) as { error: string }).error).toContain("lines 9999-100000 on the new side of src/auth.ts is not in one hunk");
  await refused(route, comment({ lineStart: 2, lineEnd: 2 }), 422, "validation_error");
  await refused(route, comment({ side: "old", lineStart: 1, lineEnd: 2 }), 422, "validation_error");
  await refused(`/api/inbox/messages/${plain.message_id}/guide/annotations`, comment(), 404, "guide_not_found");
  await refused(`/api/inbox/messages/msg_00000000000000000000000000/guide/annotations`, comment(), 404, "message_not_found");
  const crossSite = await post(server, route, { annotation: comment() }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
  expect(crossSite.status).toBe(403);
  expect((await post(server, route, { serverSession: "an-older-inbox", annotation: comment() })).status).toBe(409);
  expect(await pending(server, sent.thread_id)).toHaveLength(0);

  // A guide comment's id is not an attachment annotation's, nor the other way round.
  expect((await post(server, route, { annotation: comment() })).status).toBe(200);
  const viaAttachment = await post(server, "/api/inbox/annotations", { attachment_id: plain.attachments[0].id, version: "current", annotation: { id: "ann-guide-1", text: "x" } });
  expect(viaAttachment.status).toBe(422);
  expect((await post(server, "/api/inbox/annotations", { attachment_id: plain.attachments[0].id, version: "current", annotation: { id: "ann-file-1", text: "x" } })).status).toBe(200);
  await refused(route, comment({ id: "ann-file-1" }), 422, "validation_error");
});

test("a resolved thread takes no new comment and no edit (409) until it is reopened", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await sendGuide(client, project);
  const route = `/api/inbox/messages/${sent.message_id}/guide/annotations`;
  expect((await post(server, route, { annotation: comment() })).status).toBe(200);
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/resolve`, { resolved: true })).status).toBe(200);
  for (const annotation of [comment({ id: "ann-guide-new" }), comment({ text: "An edit." })]) {
    const answer = await post(server, route, { annotation });
    expect(answer.status).toBe(409);
    expect(((await answer.json()) as { code: string }).code).toBe("thread_resolved");
  }
  expect((await post(server, `/api/inbox/messages/${sent.message_id}/resolve`, { resolved: false })).status).toBe(200);
  expect((await post(server, route, { annotation: comment({ text: "An edit." }) })).status).toBe(200);
});

test("Send carries the comments as the review app's export under the guided review's heading; the agent's read_thread returns it, and a sent comment is closed", async () => {
  const { project, dataDir } = world();
  let server = await start(dataDir);
  let client = await agent(server);
  const sent = await sendGuide(client, project);
  const route = `/api/inbox/messages/${sent.message_id}/guide/annotations`;
  expect((await post(server, route, { annotation: comment() })).status).toBe(200);
  expect((await post(server, route, { annotation: comment({ id: "ann-guide-2", filePath: "package.json", side: "old", text: "Keep the empty object.", selectedText: "{}" }) })).status).toBe(200);

  // A restart reads them back from annotations.jsonl.
  server.stop();
  servers.splice(servers.indexOf(server), 1);
  await client.close();
  server = await start(dataDir);
  client = await agent(server);
  const records = await pending(server, sent.thread_id);
  expect(records.map((r) => r.id).sort()).toEqual(["ann-guide-1", "ann-guide-2"]);

  // The window builds the feedback text exactly as on Send (packages/inbox/attachments.ts).
  const feedback = attachmentFeedback(records, [], new Map(), project);
  const reply = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, {
    idempotency_key: "send-1",
    words: "Two notes on the diff.",
    feedback,
    annotation_ids: records.map((r) => r.id),
  });
  expect(reply.status).toBe(200);
  const body = ((await reply.json()) as { reply: { body: string } }).reply.body;
  expect(body.indexOf("Two notes on the diff.")).toBeLessThan(body.indexOf("# Feedback on the guided review"));
  for (const part of ["Token refresh", "## src/auth.ts", "### Line 1 (new)", "Refresh before it expires, not after.", "```\nnew\n```", "## package.json", "### Line 1 (old)", "Keep the empty object.", "```\n{}\n```"]) {
    expect(body).toContain(part);
  }

  // Sent: no longer pending, closed to edits and removal.
  expect(await pending(server, sent.thread_id)).toHaveLength(0);
  const late = await post(server, route, { annotation: comment({ text: "late" }) });
  expect(late.status).toBe(409);
  expect((await post(server, `/api/inbox/annotations/ann-guide-1/remove`, {})).status).toBe(409);

  // The agent that sent the guide reads the reply with the comments.
  const answer = await call(client, "read_thread", { thread_id: sent.thread_id, agent_session: "ses_guide", format: "full" });
  expect(JSON.stringify(answer)).toContain("Refresh before it expires, not after.");
  expect(JSON.stringify(answer)).toContain("src/auth.ts");
});
