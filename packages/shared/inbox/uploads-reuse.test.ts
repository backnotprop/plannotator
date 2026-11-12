import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import * as realFs from "node:fs";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordInboxAttachments } from "./attachments";
import { InboxStore } from "./store";
import { INBOX_UPLOAD_MAX_BYTES, inboxUploadAttachments, inboxUploadFromAttachment, readInboxUpload, removeInboxUploads, sweepInboxUploads } from "./uploads";

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

async function personReply(threadId: string, uploadIds: string[]) {
  const attachments = await inboxUploadAttachments(dir, uploadIds, AT);
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
  const [made] = await inboxUploadAttachments(dir, [upload.upload_id], AT);
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
  const sent = await inboxUploadFromAttachment(dir, source, "sent", { at: AT });
  expect(sent.sha256).toBe(source.sent_sha256);
  writeFileSync(file, "\x89PNG\r\n\x1a\nversion three");
  const [current, older] = await inboxUploadAttachments(dir, [upload.upload_id, sent.upload_id], AT);
  expect(readFileSync(current!.path, "utf8")).toBe(V2);
  expect(readFileSync(older!.path, "utf8")).toBe(V1);
});

test("a file the agent deleted still gives the version it sent; its current version says why not", async () => {
  const source = (await agentThread("a", "one")).attachments![0]!;
  rmSync(file);
  expect((await inboxUploadFromAttachment(dir, source, "sent", { at: AT })).sha256).toBe(source.sent_sha256);
  await expect(inboxUploadFromAttachment(dir, source, "current", { at: AT })).rejects.toThrow(/Add the version it sent/);
});

test("a film keeps its length across the reuse", async () => {
  const source = (await agentThread("a", "one")).attachments![0]!;
  const upload = await inboxUploadFromAttachment(dir, { ...source, duration_ms: 4200 }, "sent", { at: AT });
  expect(readInboxUpload(dir, upload.upload_id)?.duration_ms).toBe(4200);
  expect((await inboxUploadAttachments(dir, [upload.upload_id], AT))[0]!.duration_ms).toBe(4200);
});

test("deleting either thread leaves the other's file; the blob goes with the last user", async () => {
  const one = await agentThread("a", "one");
  const two = await agentThread("b", "two");
  const source = one.attachments![0]!;
  const upload = await inboxUploadFromAttachment(dir, source, "sent", { at: AT });
  const made = (await personReply(two.thread_id, [upload.upload_id]))[0]!;
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
  const [first] = await personReply(one.thread_id, [(await inboxUploadFromAttachment(dir, source, "sent", { at: AT })).upload_id]);
  const [second] = await personReply(two.thread_id, [(await inboxUploadFromAttachment(dir, source, "sent", { at: AT })).upload_id]);
  chmodSync(first!.path, 0o600);
  expect(statSync(second!.path).mode & 0o777).toBe(0o400);
  writeFileSync(first!.path, "an agent's notes");
  expect(readFileSync(second!.path, "utf8")).toBe(V1);
  expect(sha(readFileSync(join(dir, "blobs", source.sent_sha256)))).toBe(source.sent_sha256);
});

test("a name an upload could not have is refused, so nothing reaches a path", async () => {
  const source = (await agentThread("a", "one")).attachments![0]!;
  await expect(inboxUploadFromAttachment(dir, { ...source, name: "../../escape.png" }, "sent", { at: AT })).rejects.toThrow(/path separator/);
});

async function onDisk<T>(
  disk: { copyFile?: typeof realFsPromises.copyFile; open?: typeof realFsPromises.open; link?: typeof realFsPromises.link; linkSync?: typeof realFs.linkSync; writeFileSync?: typeof realFs.writeFileSync },
  run: () => Promise<T>,
): Promise<T> {
  const fs = { ...realFs };
  const promises = { ...realFsPromises };
  mock.module("node:fs", () => ({ ...fs, ...(disk.linkSync ? { linkSync: disk.linkSync } : {}), ...(disk.writeFileSync ? { writeFileSync: disk.writeFileSync } : {}) }));
  mock.module("node:fs/promises", () => ({ ...promises, ...(disk.copyFile ? { copyFile: disk.copyFile } : {}), ...(disk.link ? { link: disk.link } : {}), ...(disk.open ? { open: disk.open } : {}) }));
  try {
    return await run();
  } finally {
    mock.module("node:fs", () => fs);
    mock.module("node:fs/promises", () => promises);
  }
}

test("a disk with no clones still gets a copy, never a hard link, whatever the disk under this test can do", async () => {
  const source = (await agentThread("harbor", "hero")).attachments![0]!;
  const upload = await inboxUploadFromAttachment(dir, source, "sent", { at: AT });
  const linked: string[] = [];
  const [made] = await onDisk(
    {
      copyFile: (async (from: string, to: string, mode?: number) => {
        if (mode === realFs.constants.COPYFILE_FICLONE_FORCE) throw Object.assign(new Error("no clones here"), { code: "ENOTSUP" });
        realFs.writeFileSync(to, realFs.readFileSync(from));
      }) as never,
      linkSync: ((from: string) => void linked.push(from)) as never,
      link: (async (from: string) => void linked.push(from)) as never,
    },
    () => inboxUploadAttachments(dir, [upload.upload_id], AT),
  );
  expect(linked).toEqual([]);
  expect(readFileSync(made!.path, "utf8")).toBe(V1);
  expect(statSync(made!.path).nlink).toBe(1);
});

test("a full disk says so at Send, keeps nothing half made, and the upload can go again", async () => {
  const upload = await inboxUploadFromAttachment(dir, (await agentThread("harbor", "hero")).attachments![0]!, "sent", { at: AT });
  const before = readdirSync(join(dir, "uploads")).sort();
  const blobsBefore = blobs();
  const refused = await onDisk(
    {
      copyFile: (async (_from: string, to: string) => {
        writeFileSync(to, "half a fi");
        throw Object.assign(new Error("no room"), { code: "ENOSPC" });
      }) as never,
    },
    () => inboxUploadAttachments(dir, [upload.upload_id], AT).catch((error) => error),
  );
  expect(refused.code).toBe("upload_no_space");
  expect(refused.message).toContain("disk is full");
  expect(readdirSync(join(dir, "uploads")).sort()).toEqual(before);
  expect(readdirSync(join(dir, "blobs")).filter((name) => name.startsWith("."))).toEqual([]);
  expect(blobs()).toEqual(blobsBefore);
  expect(await inboxUploadAttachments(dir, [upload.upload_id], AT)).toHaveLength(1);
});

test("a crash mid-copy leaves only a temp the upload sweep takes: nothing half made in uploads/", async () => {
  const upload = await inboxUploadFromAttachment(dir, (await agentThread("harbor", "hero")).attachments![0]!, "sent", { at: AT });
  const before = readdirSync(join(dir, "uploads")).sort();
  let during: string[] = [];
  let half = "";
  await onDisk(
    {
      copyFile: (async (_from: string, to: string) => {
        half = to;
        realFs.writeFileSync(to, "half a fi");
        during = readdirSync(join(dir, "uploads")).sort();
        throw Object.assign(new Error("gone"), { code: "EIO" });
      }) as never,
    },
    () => inboxUploadAttachments(dir, [upload.upload_id], AT).catch(() => null),
  );
  expect(during).toEqual(before);
  writeFileSync(half, "half a fi");
  sweepInboxUploads(dir, { keep: new Set([upload.upload_id]), usedBlobs: new Set(), now: Date.now() + 11 * 60_000 });
  expect(existsSync(half)).toBe(false);
});

test("a full disk says so when adding too: a changed file's bytes, or the record of one already held", async () => {
  const source = (await agentThread("harbor", "hero")).attachments![0]!;
  writeFileSync(file, V2);
  const trueOpen = realFsPromises.open;
  const trueWrite = realFs.writeFileSync;
  const changed = await onDisk(
    { open: (async (path: string, ...rest: unknown[]) => {
        if (!String(path).includes(".upload.")) return (trueOpen as (...a: unknown[]) => unknown)(path, ...rest);
        throw Object.assign(new Error("no room"), { code: "ENOSPC" });
      }) as never },
    () => inboxUploadFromAttachment(dir, source, "current", { at: AT }).catch((error) => error),
  );
  expect([changed.code, changed.message]).toEqual(["upload_no_space", "The disk is full, so the file could not be added. Free some space and try again."]);
  const record = await onDisk(
    { writeFileSync: ((path: string, ...rest: unknown[]) => {
        if (String(path).includes("/pending/")) throw Object.assign(new Error("no room"), { code: "EDQUOT" });
        return (trueWrite as (...a: unknown[]) => unknown)(path, ...rest);
      }) as never },
    () => inboxUploadFromAttachment(dir, source, "sent", { at: AT }).catch((error) => error),
  );
  expect(record.code).toBe("upload_no_space");
});

test("a big changed file's upload keeps the listing's stat name; anything else from the request is not kept", async () => {
  const source = (await agentThread("harbor", "hero")).attachments![0]!;
  writeFileSync(file, V2);
  const named = await inboxUploadFromAttachment(dir, source, "current", { at: AT, sha256: "stat:12:34.5" });
  expect(readInboxUpload(dir, named.upload_id)!.shown_sha256).toBe("stat:12:34.5");
  const junk = await inboxUploadFromAttachment(dir, source, "current", { at: AT, sha256: "stat:../../x" });
  expect(junk.shown_sha256).toBeUndefined();
});

test("a stale tab gets the bytes it showed, or a refusal: never newer bytes under the same tile", async () => {
  const source = (await agentThread("harbor", "hero")).attachments![0]!;
  writeFileSync(file, V2);
  const shownFirst = await inboxUploadFromAttachment(dir, source, "current", { at: AT, sha256: sha(V1) });
  expect(shownFirst.sha256).toBe(sha(V1));
  const shownNow = await inboxUploadFromAttachment(dir, source, "current", { at: AT, sha256: sha(V2) });
  expect(shownNow.sha256).toBe(sha(V2));
  writeFileSync(file, "\x89PNG\r\n\x1a\nversion three");
  await expect(inboxUploadFromAttachment(dir, source, "current", { at: AT, sha256: sha(V2) })).rejects.toThrow("changed since this page showed it");
  const big = await inboxUploadFromAttachment(dir, source, "current", { at: AT, sha256: "stat:12:34" });
  expect(big.sha256).toBe(sha("\x89PNG\r\n\x1a\nversion three"));
});

test("an agent's edit that is no longer the file's kind says why, and the version it sent still goes", async () => {
  const picture = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex");
  writeFileSync(file, picture);
  const source = (await agentThread("harbor", "hero")).attachments![0]!;
  writeFileSync(file, "the agent's words, not a picture");
  await expect(inboxUploadFromAttachment(dir, source, "current", { at: AT })).rejects.toThrow("is no longer an image. Add the version it sent.");
  expect((await inboxUploadFromAttachment(dir, source, "sent", { at: AT })).sha256).toBe(sha(picture));
});

test("the blob gone: refused by name, not a pending upload that fails at Send", async () => {
  const source = (await agentThread("harbor", "hero")).attachments![0]!;
  rmSync(join(dir, "blobs", source.sent_sha256), { force: true });
  await expect(inboxUploadFromAttachment(dir, source, "sent", { at: AT })).rejects.toThrow(`${source.name} is no longer here.`);
});

test("a changed file past the upload limit still goes: the owner set no limit on a file already here", async () => {
  const source = (await agentThread("harbor", "hero")).attachments![0]!;
  writeFileSync(file, V2);
  truncateSync(file, INBOX_UPLOAD_MAX_BYTES + 1);
  const upload = await inboxUploadFromAttachment(dir, source, "current", { at: AT });
  expect(upload.size).toBe(INBOX_UPLOAD_MAX_BYTES + 1);
});
