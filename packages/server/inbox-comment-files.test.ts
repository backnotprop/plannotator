import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAnnotationRecord, InboxMessage, InboxUpload } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { attachmentFeedback } from "../inbox/attachments";
import { withPictures } from "../inbox/commentPictureFiles";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LOG = Buffer.from("12:01 GET /api/charts 500\n12:02 retry\n");

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-comment-files-")));
  roots.push(root);
  const project = join(root, "charts");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const client = new Client({ name: "inbox-comment-files-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const asked = (await client.callTool({ name: "send_message", arguments: { body: "The chart is rendered.\n\nThe legend sits at the right edge.", project_path: project, agent_session: "ses-pi", agent_host: "pi" } })) as {
    structuredContent: { message_id: string; thread_id: string };
  };
  return { dataDir, server, asked: asked.structuredContent };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const post = (server: InboxServer, path: string, body: unknown) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...(body as object) }) });

async function upload(server: InboxServer, name: string, bytes: Buffer): Promise<InboxUpload> {
  const response = await fetch(`${base(server)}/api/inbox/uploads?name=${encodeURIComponent(name)}&serverSession=${server.serverSession}`, { method: "POST", body: bytes });
  expect(response.status).toBe(200);
  return ((await response.json()) as { upload: InboxUpload }).upload;
}

test("a file on a comment rides the reply as an attachment and is named under the comment", async () => {
  const { server, asked } = await setup();
  const log = await upload(server, "debug.log", LOG);
  const saved = await post(server, `/api/inbox/messages/${asked.message_id}/annotations`, {
    annotation: {
      id: "ann-log",
      blockId: "block-2",
      startOffset: 0,
      endOffset: 33,
      type: "COMMENT",
      text: "The log shows the 500.",
      originalText: "The legend sits at the right edge.",
      createdA: 1,
      images: [{ path: `${log.upload_id}/${log.name}`, name: "debug.log", kind: "file" }],
    },
  });
  expect(saved.status).toBe(200);
  const record = ((await saved.json()) as { annotation: InboxAnnotationRecord }).annotation;
  const plain = await post(server, `/api/inbox/messages/${asked.message_id}/annotations`, {
    annotation: { id: "ann-bad", blockId: "block-2", startOffset: 0, endOffset: 33, type: "COMMENT", text: "x", originalText: "The legend sits at the right edge.", createdA: 1, images: [{ path: `${log.upload_id}/${log.name}`, name: "debug" }] },
  });
  expect(plain.status).toBe(404);

  const sent = await post(server, `/api/inbox/messages/${asked.message_id}/reply`, {
    idempotency_key: "send-1",
    words: "",
    questions: [],
    feedback: attachmentFeedback([record], [], new Map(), ""),
    annotation_ids: [record.id],
    uploads: withPictures([], [record]),
  });
  expect(sent.status).toBe(200);
  const reply = ((await sent.json()) as { reply: InboxMessage }).reply;
  expect(reply.attachments?.map((a) => a.name)).toEqual(["debug.log"]);
  expect(readFileSync(reply.attachments![0]!.path)).toEqual(LOG);
  const poll = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session: "ses-pi", host: "pi", waitMs: 0 }),
  });
  const [command] = parseInboxBridgeCommands(await poll.text());
  expect(command!.body as string).toContain("> The log shows the 500.\n**Attached files:**\n- [debug.log] `debug.log`\n");
});

test("a comment box's draft is kept by the server, refuses a stale save, and holds its file past the sweep", async () => {
  const { server, dataDir, asked } = await setup();
  const thread = asked.thread_id;
  const key = "guide-global:msg";
  const log = await upload(server, "debug.log", LOG);
  const draftPath = `/api/inbox/threads/${thread}/comment-draft`;
  const first = await post(server, draftPath, { key, text: "Keep the log", images: [{ path: `${log.upload_id}/${log.name}`, name: "debug.log", kind: "file" }], base: null });
  expect(first.status).toBe(200);
  const { draft } = (await first.json()) as { draft: { updated_at: string } };
  const stale = await post(server, draftPath, { key, text: "Older window", images: [], base: null });
  expect([stale.status, ((await stale.json()) as { code: string }).code]).toEqual([409, "draft_conflict"]);
  expect((await post(server, draftPath, { key, text: "Keep the log with it", images: [{ path: `${log.upload_id}/${log.name}`, name: "debug.log", kind: "file" }], base: draft.updated_at })).status).toBe(200);

  const pending = join(dataDir, "inbox", "uploads", "pending", `${log.upload_id}.json`);
  const record = JSON.parse(readFileSync(pending, "utf8")) as InboxUpload;
  writeFileSync(pending, JSON.stringify({ ...record, created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
  server.stop();
  const again = await startInboxServer({ dataDir });
  servers.push(again);
  expect(existsSync(pending)).toBe(true);
  const read = await fetch(`${base(again)}${draftPath}?key=${encodeURIComponent(key)}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
  const kept = ((await read.json()) as { draft: { text: string; images: unknown[] } }).draft;
  expect([kept.text, kept.images.length]).toEqual(["Keep the log with it", 1]);
});
