/**
 * A picture on a comment (the owner, 2026-11-11: "Match Annotate: turn
 * pictures on"), through a real Inbox in a temp data dir. The picture is one
 * of the reply box's own uploads: the comment names it, the window shows it
 * back from `uploads/<id>/image`, and the Send that carries the comment
 * carries the upload, so the agent gets it as one of the reply's attachments
 * and reads its file named beside the comment (the window's own feedback
 * text, `attachmentFeedback`). A waiting comment keeps its picture past the
 * day the upload sweep allows; a removed comment's picture goes with it.
 */
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

/** A real 1x1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const BODY = "The chart is rendered.\n\nThe legend sits at the right edge.";

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-comment-pictures-")));
  roots.push(root);
  const project = join(root, "charts");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const start = async () => {
    const server = await startInboxServer({ dataDir });
    servers.push(server);
    return server;
  };
  const server = await start();
  const client = new Client({ name: "inbox-comment-pictures-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const asked = (await client.callTool({ name: "send_message", arguments: { body: BODY, project_path: project, agent_session: "ses-pi", agent_host: "pi" } })) as {
    structuredContent: { message_id: string; thread_id: string };
  };
  return { root, project, dataDir, server, start, asked: asked.structuredContent };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const post = (server: InboxServer, path: string, body: unknown) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...(body as object) }) });

/** The picture as the comment box uploads it: the reply box's upload route, named after the picture. */
async function uploadPicture(server: InboxServer, name: string): Promise<InboxUpload> {
  const response = await fetch(`${base(server)}/api/inbox/uploads?name=${encodeURIComponent(name)}&serverSession=${server.serverSession}`, { method: "POST", body: PNG });
  expect(response.status).toBe(200);
  return ((await response.json()) as { upload: InboxUpload }).upload;
}

/** A comment on the agent's words with one picture, as the window's viewer saves it. */
async function commentWithPicture(server: InboxServer, messageId: string, upload: InboxUpload): Promise<InboxAnnotationRecord> {
  const response = await post(server, `/api/inbox/messages/${messageId}/annotations`, {
    annotation: {
      id: "ann-legend",
      blockId: "block-2",
      startOffset: 0,
      endOffset: 33,
      type: "COMMENT",
      text: "It is cut off on my screen.",
      originalText: "The legend sits at the right edge.",
      createdA: 1,
      images: [{ path: `${upload.upload_id}/${upload.name}`, name: "legend" }],
    },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { annotation: InboxAnnotationRecord }).annotation;
}

const pendingFile = (dataDir: string, id: string) => join(dataDir, "inbox", "uploads", "pending", `${id}.json`);

test("a comment's picture reaches the agent as an attachment of the reply, its file named beside the comment", async () => {
  const { server, asked } = await setup();
  const upload = await uploadPicture(server, "legend.png");
  // The comment box shows it back before the Send, from the Inbox.
  const shown = await fetch(`${base(server)}/api/inbox/uploads/${upload.upload_id}/image`);
  expect([shown.status, shown.headers.get("content-type"), shown.headers.get("x-content-type-options")]).toEqual([200, "image/png", "nosniff"]);
  const record = await commentWithPicture(server, asked.message_id, upload);
  expect(record.annotation.images).toEqual([{ path: `${upload.upload_id}/legend.png`, name: "legend" }]);

  // The window's Send: the comments' feedback, and the uploads their pictures name.
  const feedback = attachmentFeedback([record], [], new Map(), "");
  const sent = await post(server, `/api/inbox/messages/${asked.message_id}/reply`, {
    idempotency_key: "send-1",
    words: "",
    questions: [],
    feedback,
    annotation_ids: [record.id],
    uploads: withPictures([], [record]),
  });
  expect(sent.status).toBe(200);
  const reply = ((await sent.json()) as { reply: InboxMessage }).reply;
  expect(reply.attachments?.map((a) => [a.name, a.kind])).toEqual([["legend.png", "image"]]);
  expect(readFileSync(reply.attachments![0]!.path)).toEqual(PNG);

  // What the agent reads: the comment, its picture's file under it, and that file attached with its path.
  const poll = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session: "ses-pi", host: "pi", waitMs: 0 }),
  });
  const [command] = parseInboxBridgeCommands(await poll.text());
  const text = command!.body as string;
  expect(text).toContain("> It is cut off on my screen.\n**Attached images:**\n- [legend] `legend.png`\n");
  expect(text).toContain(`Attached: legend.png (${reply.attachments![0]!.path})`);
});

test("a waiting comment keeps its picture past the upload sweep's day; a removed comment's picture is swept", async () => {
  const { server, dataDir, asked } = await setup();
  const upload = await uploadPicture(server, "legend.png");
  await commentWithPicture(server, asked.message_id, upload);
  const ageOut = () => {
    // Two days old: past the day an upload no draft names is kept (the sweep runs as the Inbox starts).
    const record = JSON.parse(readFileSync(pendingFile(dataDir, upload.upload_id), "utf8")) as InboxUpload;
    writeFileSync(pendingFile(dataDir, upload.upload_id), JSON.stringify({ ...record, created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
  };

  ageOut();
  server.stop();
  const again = await (async () => {
    const restarted = await startInboxServer({ dataDir });
    servers.push(restarted);
    return restarted;
  })();
  expect(existsSync(pendingFile(dataDir, upload.upload_id))).toBe(true);
  expect((await fetch(`${base(again)}/api/inbox/uploads/${upload.upload_id}/image`)).status).toBe(200);

  // Discarded: nothing names the picture now, so it goes as any unnamed upload does.
  expect((await post(again, "/api/inbox/annotations/ann-legend/remove", {})).status).toBe(200);
  again.stop();
  const third = await startInboxServer({ dataDir });
  servers.push(third);
  expect(existsSync(pendingFile(dataDir, upload.upload_id))).toBe(false);
  expect((await fetch(`${base(third)}/api/inbox/uploads/${upload.upload_id}/image`)).status).toBe(404);
});
