/** Earlier comments on a file, through the real files route. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordInboxAttachments, inboxAttachmentState } from "@plannotator/shared/inbox/attachments";
import { earlierCommentsOn } from "../inbox/earlierComments";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const comment = (id: string, text: string, originalText: string) => ({ id, blockId: "block-0", startOffset: 0, endOffset: 4, type: "COMMENT", text, originalText, createdA: 1 });

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-earlier-")));
  roots.push(root);
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const store = server.store;
  const project = store.ensureProject({ name: "shop", root });
  const author = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });
  const write = (name: string, text: string) => writeFileSync(join(root, name), text);
  const files = (...names: string[]) => recordInboxAttachments(store.dir, names, { base: root, at: new Date().toISOString() });
  const read = async (threadId: string) => (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}/attachments`)).json()) as { annotations: any[]; earlier_annotations: any[] };
  const send = (messageId: string, key: string, ids: string[]) => store.sendReply(messageId, { idempotency_key: key, words: "Notes.", feedback: "Notes.", annotation_ids: ids });
  return { store, project, author, write, files, read, send };
}

test("the read returns the sent comments of this thread, and the same path keeps them on a newer version", async () => {
  const { store, project, author, write, files, read, send } = await world();
  write("page.md", "# One\n");
  write("other.md", "# Other\n");
  const first = store.sendMessage({ project_id: project.id, author: author("a"), subject: "Page", body: "First.", attachments: await files("page.md", "other.md") }).message;
  const [page, other] = first.attachments!;
  store.saveAnnotation({ attachment_id: page!.id, version: "current", annotation: comment("ann-page", "Say why.", "One") });
  store.saveAnnotation({ attachment_id: other!.id, version: "current", annotation: comment("ann-other", "Too long.", "Other") });
  store.saveMessageAnnotation(first.id, comment("ann-msg", "On the words.", "First."));

  expect((await read(first.thread_id)).earlier_annotations).toEqual([]);
  send(first.id, "reply-1", ["ann-page", "ann-other", "ann-msg"]);

  write("page.md", "# Two\n");
  const second = store.sendMessage({ project_id: project.id, author: author("a"), reply_to: first.id, body: "Second.", attachments: await files("page.md") }).message;
  const newer = second.attachments![0]!;
  expect(newer.id).not.toBe(page!.id);
  store.saveAnnotation({ attachment_id: newer.id, version: "current", annotation: comment("ann-draft", "Better.", "Two") });

  const model = await read(first.thread_id);
  expect(model.earlier_annotations.map((r) => r.id).sort()).toEqual(["ann-other", "ann-page"]);
  expect(model.annotations.map((r) => r.id)).toEqual(["ann-draft"]);

  const state = await inboxAttachmentState(newer, second.id);
  const onNewer = earlierCommentsOn(model.earlier_annotations, state);
  expect(onNewer.flatMap((reply) => reply.comments.map((c) => c.id))).toEqual(["ann-page"]);
  expect(onNewer[0]!.comments[0]!.spot).toBe("\"One\"");
});

test("a sent comment keeps its reply's time, comes back after a restart, and goes with its thread", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-earlier-")));
  roots.push(root);
  const dataDir = join(root, "data");
  writeFileSync(join(root, "page.md"), "# One\n");
  let server = await startInboxServer({ dataDir });
  servers.push(server);
  const project = server.store.ensureProject({ name: "shop", root });
  const message = server.store.sendMessage({
    project_id: project.id,
    author: { kind: "agent", host: "claude-code", session: "a", name: "Claude Code" },
    subject: "Page",
    body: "First.",
    attachments: await recordInboxAttachments(server.store.dir, ["page.md"], { base: root, at: new Date().toISOString() }),
  }).message;
  const attachment = message.attachments![0]!;
  server.store.saveAnnotation({ attachment_id: attachment.id, version: attachment.sent_sha256, annotation: comment("ann-sent-version", "Say why.", "One") });
  const reply = server.store.sendReply(message.id, { idempotency_key: "reply-1", words: "Notes.", feedback: "Notes.", annotation_ids: ["ann-sent-version"] }).reply;

  // The panel's "From your reply · …" reads `updated_at`: it has to be the reply's own time.
  const [sent] = server.store.earlierAnnotations(message.thread_id);
  expect(sent!.updated_at).toBe(reply.created_at);
  expect(sent!.sent_reply_id).toBe(reply.id);

  server.stop();
  server = await startInboxServer({ dataDir });
  servers.push(server);
  expect(server.store.earlierAnnotations(message.thread_id).map((r) => r.id)).toEqual(["ann-sent-version"]);

  server.store.deleteThread(message.thread_id);
  expect(server.store.earlierAnnotations(message.thread_id)).toEqual([]);
});

test("another thread's comment on the same path stays in its thread", async () => {
  const { store, project, author, write, files, read, send } = await world();
  write("page.md", "# One\n");
  const mine = store.sendMessage({ project_id: project.id, author: author("a"), subject: "Mine", body: "A.", attachments: await files("page.md") }).message;
  const theirs = store.sendMessage({ project_id: project.id, author: author("b"), subject: "Theirs", body: "B.", attachments: await files("page.md") }).message;
  expect(theirs.thread_id).not.toBe(mine.thread_id);
  store.saveAnnotation({ attachment_id: theirs.attachments![0]!.id, version: "current", annotation: comment("ann-theirs", "Elsewhere.", "One") });
  send(theirs.id, "reply-theirs", ["ann-theirs"]);

  expect((await read(mine.thread_id)).earlier_annotations).toEqual([]);
  expect((await read(theirs.thread_id)).earlier_annotations.map((r) => r.id)).toEqual(["ann-theirs"]);
});

test("the comments group by the reply that carried them, the newest reply first", () => {
  const record = (id: string, reply: string, at: string, annotation: Record<string, unknown>) =>
    ({ id, path: "/w/a.mp4", sent_reply_id: reply, updated_at: at, annotation: { id, type: "COMMENT", ...annotation } }) as any;
  const replies = earlierCommentsOn(
    [
      record("a", "r1", "2026-10-03T10:00:00.000Z", { text: "Old.", blockId: "video", originalText: "a.mp4 at 1:42", inboxVideo: { time: 102.4 } }),
      record("b", "r2", "2026-11-04T10:00:00.000Z", { text: "New.", blockId: "image", originalText: "a.mp4" }),
      record("c", "r2", "2026-11-04T10:00:00.000Z", { text: "", blockId: "image", images: [{ path: "/m.png", name: "m" }] }),
    ],
    { id: "att_x", path: "/w/a.mp4" },
    new Date("2026-11-04T12:00:00.000Z"),
  );
  expect(replies.map((r) => r.replyId)).toEqual(["r2", "r1"]);
  expect(replies[0]!.label.startsWith("From your reply · Today, ")).toBe(true);
  expect(replies[0]!.comments).toEqual([
    { id: "b", words: "New.", spot: null },
    { id: "c", words: "Drawing", spot: null },
  ]);
  expect(replies[1]!.comments[0]!.spot).toBe("At 1:42");
});
