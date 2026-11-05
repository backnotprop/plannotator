/**
 * A file already in the Inbox, added to a new message (the reuse button): its
 * life on disk, against the real store in a temp folder.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordInboxAttachments } from "./attachments";
import { InboxStore } from "./store";
import { inboxUploadAttachments, inboxUploadFromAttachment, readInboxUpload, removeInboxUploads, sweepInboxUploads } from "./uploads";

let root: string;
let dir: string;
let store: InboxStore;
let file: string;

const AT = "2026-11-04T12:00:00.000Z";
const V1 = "\x89PNG\r\n\x1a\nversion one";
const V2 = "\x89PNG\r\n\x1a\nversion two";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const blobs = () => readdirSync(join(dir, "blobs")).filter((n) => /^[0-9a-f]{64}$/.test(n));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-uploads-reuse-")));
  store = InboxStore.open(join(root, "data"));
  dir = store.dir;
  file = join(root, "ref02.png");
  writeFileSync(file, V1);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function agentThread(project: string, thread: string) {
  const attachments = await recordInboxAttachments(dir, [file], { base: root, at: AT });
  const home = store.ensureProject({ name: project, root: join(root, project) });
  return store.sendMessage({ project_id: home.id, author: { kind: "agent", host: "pi", session: `ses-${thread}`, name: null }, body: "Here.", thread, attachments }).message;
}

function personReply(threadId: string, uploadIds: string[]) {
  const attachments = inboxUploadAttachments(dir, uploadIds, AT);
  store.sendReply(threadId, { words: "Reuse.", attachments, idempotency_key: `k-${uploadIds.join()}` });
  removeInboxUploads(dir, uploadIds);
  return attachments;
}

test("no bytes are written; Send makes an ordinary read-only attachment of its own, with no link back", async () => {
  const source = (await agentThread("a", "one")).attachments![0]!;
  const before = blobs();
  const upload = await inboxUploadFromAttachment(dir, source, "sent", { at: AT });
  expect(blobs()).toEqual(before);
  expect(upload.sha256).toBe(source.sent_sha256);
  const pending = readFileSync(join(dir, "uploads", "pending", `${upload.upload_id}.json`), "utf8");
  for (const leak of [source.path, source.id, root]) expect(pending).not.toContain(leak);
  const [made] = inboxUploadAttachments(dir, [upload.upload_id], AT);
  expect(made!.id).not.toBe(source.id);
  expect(made!.path).toBe(join(dir, "uploads", made!.id, "ref02.png"));
  expect(statSync(made!.path).mode & 0o777).toBe(0o400);
  expect(readFileSync(made!.path, "utf8")).toBe(V1);
  expect(blobs()).toEqual(before);
});

test("the current version of a changed file takes one blob, once, and is fixed there", async () => {
  const source = (await agentThread("a", "one")).attachments![0]!;
  writeFileSync(file, V2);
  const before = blobs().length;
  const upload = await inboxUploadFromAttachment(dir, source, "current", { at: AT });
  expect(blobs().length).toBe(before + 1);
  expect(upload.sha256).toBe(sha(V2));
  expect(upload.size).toBe(Buffer.byteLength(V2, "utf8"));
  await inboxUploadFromAttachment(dir, source, "current", { at: AT });
  expect(blobs().length).toBe(before + 1);
  // The version it sent is still a choice, and the agent changing the file again moves neither.
  const sent = await inboxUploadFromAttachment(dir, source, "sent", { at: AT });
  expect(sent.sha256).toBe(source.sent_sha256);
  writeFileSync(file, "\x89PNG\r\n\x1a\nversion three");
  const [current, older] = inboxUploadAttachments(dir, [upload.upload_id, sent.upload_id], AT);
  expect(readFileSync(current!.path, "utf8")).toBe(V2);
  expect(readFileSync(older!.path, "utf8")).toBe(V1);
});

test("a file the agent deleted still gives the version it sent; its current version says why not", async () => {
  const source = (await agentThread("a", "one")).attachments![0]!;
  rmSync(file);
  expect((await inboxUploadFromAttachment(dir, source, "sent", { at: AT })).sha256).toBe(source.sent_sha256);
  await expect(inboxUploadFromAttachment(dir, source, "current", { at: AT })).rejects.toThrow(/add the version it sent/);
});

test("a film keeps its length across the reuse", async () => {
  const source = (await agentThread("a", "one")).attachments![0]!;
  const upload = await inboxUploadFromAttachment(dir, { ...source, duration_ms: 4200 }, "sent", { at: AT });
  expect(readInboxUpload(dir, upload.upload_id)?.duration_ms).toBe(4200);
  expect(inboxUploadAttachments(dir, [upload.upload_id], AT)[0]!.duration_ms).toBe(4200);
});

test("deleting either thread leaves the other's file; the blob goes with the last user", async () => {
  const one = await agentThread("a", "one");
  const two = await agentThread("b", "two");
  const source = one.attachments![0]!;
  const upload = await inboxUploadFromAttachment(dir, source, "sent", { at: AT });
  const made = personReply(two.thread_id, [upload.upload_id])[0]!;
  const blob = join(dir, "blobs", source.sent_sha256);
  store.deleteThread(one.thread_id);
  expect(existsSync(blob)).toBe(true);
  expect(readFileSync(made.path, "utf8")).toBe(V1);
  expect(store.attachment(made.id)?.attachment.path).toBe(made.path);
  store.deleteThread(two.thread_id);
  expect(existsSync(made.path)).toBe(false);
  expect(existsSync(blob)).toBe(false);
});

test("a pending reuse holds the blob through a delete; forgotten, the sweep takes it after its 24 hours", async () => {
  const one = await agentThread("a", "one");
  const source = one.attachments![0]!;
  const upload = await inboxUploadFromAttachment(dir, source, "sent", { at: AT });
  const blob = join(dir, "blobs", source.sent_sha256);
  store.deleteThread(one.thread_id);
  expect(existsSync(blob)).toBe(true);
  sweepInboxUploads(dir, { keep: new Set(), usedBlobs: new Set(), now: Date.parse(AT) + 25 * 60 * 60 * 1000 });
  expect(readInboxUpload(dir, upload.upload_id)).toBeNull();
  expect(existsSync(blob)).toBe(false);
});

test("one message's file is its own: an agent that chmods its copy and writes in place changes no other message and not the blob", async () => {
  const one = await agentThread("a", "one");
  const two = await agentThread("b", "two");
  const source = one.attachments![0]!;
  const first = personReply(one.thread_id, [(await inboxUploadFromAttachment(dir, source, "sent", { at: AT })).upload_id])[0]!;
  const second = personReply(two.thread_id, [(await inboxUploadFromAttachment(dir, source, "sent", { at: AT })).upload_id])[0]!;
  chmodSync(first.path, 0o600);
  expect(statSync(second.path).mode & 0o777).toBe(0o400);
  writeFileSync(first.path, "an agent's notes");
  expect(readFileSync(second.path, "utf8")).toBe(V1);
  expect(sha(readFileSync(join(dir, "blobs", source.sent_sha256)))).toBe(source.sent_sha256);
});

test("a name an upload could not have is refused, so nothing reaches a path", async () => {
  const source = (await agentThread("a", "one")).attachments![0]!;
  await expect(inboxUploadFromAttachment(dir, { ...source, name: "../../escape.png" }, "sent", { at: AT })).rejects.toThrow(/path separator/);
});
