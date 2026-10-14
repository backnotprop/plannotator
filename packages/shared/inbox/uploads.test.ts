/**
 * The person's uploads on disk. What can regress: an oversized or aborted
 * upload leaving bytes behind, the sweep dropping a file a draft still names
 * or a blob a message uses, and the store's blob sweep (after a deletion)
 * removing a file that is uploaded but not sent yet.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxBlobPath, inboxBlobsDir } from "./attachments";
import { InboxError } from "./schema";
import { InboxStore } from "./store";
import { INBOX_UPLOAD_KEEP_MS, inboxUploadAttachments, listInboxUploads, receiveInboxUpload, sweepInboxUploads } from "./uploads";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-uploads-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  return { store, inbox: store.dir };
}

const stream = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });

const at = (ms: number) => new Date(ms).toISOString();

describe("uploads", () => {
  test("a body over the cap is refused and leaves no temp file or blob", async () => {
    const { inbox } = world();
    const error = await receiveInboxUpload(inbox, "big.log", stream("1234", "5678", "9"), { at: at(0), maxBytes: 8 }).catch((e) => e);
    expect(error).toBeInstanceOf(InboxError);
    expect((error as InboxError).code).toBe("upload_too_large");
    expect(existsSync(inboxBlobsDir(inbox)) ? readdirSync(inboxBlobsDir(inbox)) : []).toEqual([]);
    expect(listInboxUploads(inbox)).toEqual([]);
  });

  test("the sweep forgets day-old uploads no draft names, keeps a draft's, and never removes a blob a message uses", async () => {
    const { store, inbox } = world();
    const now = Date.parse("2026-10-14T12:00:00Z");
    const old = now - INBOX_UPLOAD_KEEP_MS - 1;
    const forgotten = await receiveInboxUpload(inbox, "a.txt", stream("forgotten"), { at: at(old) });
    const drafted = await receiveInboxUpload(inbox, "b.txt", stream("drafted"), { at: at(old) });
    const fresh = await receiveInboxUpload(inbox, "c.txt", stream("fresh"), { at: at(now) });
    // Sent once (a message uses the blob), and uploaded again: the old pending copy goes, the blob stays.
    const sentBytes = await receiveInboxUpload(inbox, "d.txt", stream("sent"), { at: at(old) });
    const project = store.ensureProject({ name: "repo", root: "/work/repo" });
    store.startPersonThread({
      project_id: project.id,
      body: "files",
      to: { host: "pi", session: "s" },
      idempotency_key: "k",
      attachments: inboxUploadAttachments(inbox, [sentBytes.upload_id], at(old)),
    });
    const swept = sweepInboxUploads(inbox, { keep: new Set([drafted.upload_id]), usedBlobs: store.usedBlobs(), now });
    expect(swept.sort()).toEqual([forgotten.upload_id, sentBytes.upload_id].sort());
    expect(listInboxUploads(inbox).map((u) => u.upload_id).sort()).toEqual([drafted.upload_id, fresh.upload_id].sort());
    expect(existsSync(inboxBlobPath(inbox, forgotten.sha256))).toBe(false);
    expect(existsSync(inboxBlobPath(inbox, drafted.sha256))).toBe(true);
    expect(existsSync(inboxBlobPath(inbox, sentBytes.sha256))).toBe(true);
  });

  test("deleting a thread keeps uploads not sent yet and removes the sent upload's file with its message", async () => {
    const { store, inbox } = world();
    const project = store.ensureProject({ name: "repo", root: "/work/repo" });
    const pending = await receiveInboxUpload(inbox, "pending.txt", stream("not sent yet"), { at: at(Date.now()) });
    const sent = await receiveInboxUpload(inbox, "sent.txt", stream("sent with the thread"), { at: at(Date.now()) });
    const attachments = inboxUploadAttachments(inbox, [sent.upload_id], at(Date.now()));
    const { message } = store.startPersonThread({ project_id: project.id, body: "files", to: { host: "pi", session: "s" }, idempotency_key: "k", attachments });
    expect(existsSync(attachments[0]!.path)).toBe(true);
    store.deleteThread(message.thread_id);
    expect(existsSync(inboxBlobPath(inbox, pending.sha256))).toBe(true);
    expect(existsSync(attachments[0]!.path)).toBe(false);
  });
});
