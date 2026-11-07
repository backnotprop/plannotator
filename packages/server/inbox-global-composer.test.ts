import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxMessage, InboxReplyDraft, InboxUpload } from "@plannotator/core/inbox-types";
import { sweepInboxUploads, readInboxUpload } from "@plannotator/shared/inbox/uploads";
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

async function start(dataDir: string) {
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return server;
}
async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-global-composer-")));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "notes.md"), "# Notes\n");
  const dataDir = join(root, "data");
  const server = await start(dataDir);
  const client = new Client({ name: "global-comments-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const call = async (name: string, extra: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { project_path: project, agent_session: "reviewer", ...extra } });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent as { message_id: string; thread_id: string };
  };
  const sent = await call("send_message", { body: "Read the notes.", attachments: ["notes.md"] });
  return { server, client, root, project, dataDir, call, ...sent };
}
function url(server: InboxServer, path: string) { return `http://127.0.0.1:${server.port}/api/inbox${path}`; }
function post(server: InboxServer, path: string, body: Record<string, unknown>, headers = {}) {
  return fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
}
function route(id: string, scope: string, remove = false) { return `/messages/${id}/comment-draft${remove ? "/delete" : ""}?scope=${encodeURIComponent(scope)}`; }
async function readDraft(server: InboxServer, path: string) { return (await (await fetch(url(server, path))).json() as { draft: InboxReplyDraft | null }).draft; }
async function save(server: InboxServer, path: string, body: string, base: string | null = null, files: string[] = []) {
  const response = await post(server, path, { body, base, files, all_files: true });
  expect(response.status).toBe(200);
  return (await response.json() as { draft: InboxReplyDraft | null }).draft!;
}
async function upload(server: InboxServer, name: string, text = "supporting evidence\n") {
  const response = await fetch(url(server, `/uploads?name=${name}&serverSession=${server.serverSession}`), { method: "POST", body: text });
  expect(response.status).toBe(200);
  return (await response.json() as { upload: InboxUpload }).upload;
}
async function annotate(server: InboxServer, messageId: string, id: string, file: InboxUpload) {
  const message = server.store.message(messageId)!;
  const attachment = message.attachments![0]!;
  return post(server, "/annotations", { attachment_id: attachment.id, version: "current", annotation: {
    id, type: "GLOBAL_COMMENT", text: "Check the evidence", blockId: "", originalText: "", startOffset: 0, endOffset: 0, createdA: 1,
    files: [{ id: file.upload_id, name: "untrusted name" }],
  } });
}

test("comment drafts survive a restart and never replace a reply or another document draft", async () => {
  const w = await world();
  const first = route(w.message_id, "attachment:notes:current");
  const other = route(w.message_id, "attachment:notes:sent");
  const file = await upload(w.server, "evidence.txt");
  await save(w.server, `/threads/${w.thread_id}/draft`, "reply words");
  await save(w.server, first, "comment words", null, [file.upload_id]);
  await save(w.server, other, "other version");
  expect((await readDraft(w.server, `/threads/${w.thread_id}/draft`))?.body).toBe("reply words");
  expect((await readDraft(w.server, first))?.files?.[0]?.name).toBe("evidence.txt");
  await w.client.close();
  w.server.stop();
  servers.splice(servers.indexOf(w.server), 1);
  const restarted = await start(w.dataDir);
  expect((await readDraft(restarted, first))?.body).toBe("comment words");
  expect((await readDraft(restarted, other))?.body).toBe("other version");
  expect((await readDraft(restarted, `/threads/${w.thread_id}/draft`))?.body).toBe("reply words");
  restarted.store.deleteThread(w.thread_id);
  expect(restarted.store.replyDraftUploadIds().size).toBe(0);
});

test("a stale comment save or completion cannot discard newer words; window guards still apply", async () => {
  const w = await world();
  const path = route(w.message_id, "guide-global");
  const first = await save(w.server, path, "first");
  const newer = await save(w.server, path, "newer", first.updated_at);
  expect((await post(w.server, path, { body: "stale", base: first.updated_at })).status).toBe(409);
  expect(await (await post(w.server, route(w.message_id, "guide-global", true), { base: first.updated_at })).json()).toMatchObject({ deleted: false });
  expect((await readDraft(w.server, path))?.body).toBe("newer");
  expect((await post(w.server, path, { body: "cross site", base: newer.updated_at }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await post(w.server, path, { body: "old tab", serverSession: "wrong" })).status).toBe(409);
  expect(await (await post(w.server, route(w.message_id, "guide-global", true), { base: newer.updated_at })).json()).toMatchObject({ deleted: true });
});

test("Send delivers the selected global comment's bytes and association, without a client upload list; a replay sends nothing twice", async () => {
  const w = await world();
  const file = await upload(w.server, "evidence.txt");
  const added = await annotate(w.server, w.message_id, "global-evidence", file);
  expect(added.status).toBe(200);
  expect((await added.json() as { annotation: { annotation: { files: unknown } } }).annotation.annotation.files).toEqual([{ id: file.upload_id, name: "evidence.txt" }]);
  const body = { idempotency_key: "send-evidence", words: "", annotation_ids: ["global-evidence"] };
  const sent = await post(w.server, `/messages/${w.message_id}/reply`, body);
  expect(sent.status).toBe(200);
  const reply = (await sent.json() as { reply: InboxMessage }).reply;
  expect(reply.attachments).toHaveLength(1);
  expect(readFileSync(reply.attachments![0]!.path, "utf8")).toBe("supporting evidence\n");
  expect(reply.body).toContain("global-evidence");
  expect(reply.body).toContain(reply.attachments![0]!.path);
  const replay = await post(w.server, `/messages/${w.message_id}/reply`, body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ replayed: true, reply: { id: reply.id } });
  const read = await w.client.callTool({ name: "read_thread", arguments: { thread_id: w.thread_id } });
  expect(JSON.stringify(read.structuredContent)).toContain(reply.attachments![0]!.path);
});

test("saved comments and other comment drafts retain shared uploads until their own Send or Discard", async () => {
  const w = await world();
  const file = await upload(w.server, "shared.txt");
  expect((await annotate(w.server, w.message_id, "first-comment", file)).status).toBe(200);
  expect((await annotate(w.server, w.message_id, "second-comment", file)).status).toBe(200);
  const pendingDraft = route(w.message_id, "another-document");
  await save(w.server, pendingDraft, "still drafting", null, [file.upload_id]);
  const dir = w.server.store.dir;
  sweepInboxUploads(dir, { keep: w.server.store.replyDraftUploadIds(), usedBlobs: w.server.store.usedBlobs(), now: Date.now() + 48 * 60 * 60 * 1000 });
  expect(readInboxUpload(dir, file.upload_id)).not.toBeNull();
  expect((await post(w.server, `/messages/${w.message_id}/reply`, { idempotency_key: "one", annotation_ids: ["first-comment"] })).status).toBe(200);
  expect(readInboxUpload(dir, file.upload_id)).not.toBeNull();
  expect((await post(w.server, `/messages/${w.message_id}/reply`, { idempotency_key: "two", annotation_ids: ["second-comment"] })).status).toBe(200);
  expect((await readDraft(w.server, pendingDraft))?.files).toHaveLength(1);
  await post(w.server, route(w.message_id, "another-document", true), {});
  sweepInboxUploads(dir, { keep: w.server.store.replyDraftUploadIds(), usedBlobs: w.server.store.usedBlobs(), now: Date.now() + 48 * 60 * 60 * 1000 });
  expect(readInboxUpload(dir, file.upload_id)).toBeNull();
});

test("a file-only guide global comment saves and sends; line comments cannot smuggle file references", async () => {
  const w = await world();
  const guide = await w.call("submit_guide", GUIDE_BRIEF_EXAMPLE);
  const file = await upload(w.server, "review.txt");
  const annotation = { id: "global-guide-file", type: "comment", scope: "general", filePath: "", lineStart: 0, lineEnd: 0, side: "new", text: "", files: [{ id: file.upload_id }] };
  expect((await post(w.server, `/messages/${guide.message_id}/guide/annotations`, { annotation })).status).toBe(200);
  const bad = await post(w.server, `/messages/${guide.message_id}/guide/annotations`, { annotation: { ...annotation, id: "line-file", scope: "line", filePath: "src/auth.ts", lineStart: 1, lineEnd: 1 } });
  expect(bad.status).toBe(422);
  const sent = await post(w.server, `/messages/${guide.message_id}/reply`, { idempotency_key: "guide-files", annotation_ids: [annotation.id] });
  expect(sent.status).toBe(200);
  expect((await sent.json() as { reply: InboxMessage }).reply.attachments?.[0]?.name).toBe("review.txt");
});

test("unknown upload references and references to another thread's comment are refused without sending", async () => {
  const w = await world();
  const gone = { upload_id: "upl_01K70000000000000000000000" } as InboxUpload;
  expect((await annotate(w.server, w.message_id, "forged", gone)).status).toBe(422);
  const file = await upload(w.server, "private.txt");
  await annotate(w.server, w.message_id, "original", file);
  const elsewhere = await w.call("send_message", { body: "Another thread.", thread: "different" });
  const response = await post(w.server, `/messages/${elsewhere.message_id}/reply`, { idempotency_key: "wrong-thread", annotation_ids: ["original"] });
  expect(response.status).toBe(404);
  expect(readInboxUpload(w.server.store.dir, file.upload_id)).not.toBeNull();
});
