/**
 * recordInboxAttachments on real files in a temp folder: the kind each file
 * gets from its name and its bytes, files from anywhere on disk, and the
 * refusals (the dotenv family by name or target, folders, FIFOs) refusing the
 * whole send before any blob is written.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, utimesSync } from "node:fs";
import { INBOX_VIEW_MAX_BYTES } from "@plannotator/core/inbox-types";
import {
  decideInboxAttachmentKind,
  inboxAttachmentState,
  inboxBlobPath,
  inboxBlobsDir,
  openInboxAttachmentVersion,
  readInboxAttachmentText,
  recordInboxAttachments,
  sweepStaleInboxSendTemps,
  STALE_SEND_TEMP_MS,
} from "./attachments";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-attach-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(join(project, "scripts"), { recursive: true });
  const inbox = join(root, "data", "inbox");
  return { root, project, inbox, at: "2026-10-10T00:00:00.000Z" };
}

function record(w: ReturnType<typeof world>, paths: unknown[]) {
  return recordInboxAttachments(w.inbox, paths, { base: w.project, at: w.at });
}

function blobs(w: ReturnType<typeof world>): string[] {
  return existsSync(inboxBlobsDir(w.inbox)) ? readdirSync(inboxBlobsDir(w.inbox)) : [];
}

/** A PNG's signature and IHDR at the given size: enough for the sniffer and the dimension read. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("code and script files are recorded as kind code, with the sent bytes in a blob", async () => {
  const w = world();
  const files: Record<string, string> = {
    "scripts/run.sh": "#!/bin/sh\n# retry the webhook\necho ok\n",
    "src.ts": "export const x = 1;\n",
    "App.swift": "import SwiftUI\n",
    "build.mjs": "export default {};\n",
    "Makefile": "all:\n\techo hi\n",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(w.project, name), text);
  const recorded = await record(w, Object.keys(files));
  expect(recorded.map((a) => a.kind)).toEqual(["code", "code", "code", "code", "code"]);
  for (const attachment of recorded) {
    expect(readFileSync(inboxBlobPath(w.inbox, attachment.sent_sha256), "utf8")).toBe(files[attachment.path.slice(w.project.length + 1)]!);
  }
});

test("the kind comes from the bytes: images, PDFs, other text as code, anything else a file", async () => {
  const w = world();
  const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
  writeFileSync(join(w.project, "shot.png"), png(1280, 800));
  writeFileSync(join(w.project, "states.svg"), svg);
  // An image under no image name, and a PDF under none: the bytes decide.
  writeFileSync(join(w.project, "capture"), png(2, 3));
  writeFileSync(join(w.project, "spec.pdf"), "%PDF-1.7\n%âã\n1 0 obj\n");
  writeFileSync(join(w.project, "report.bin"), "%PDF-1.4\n");
  // A file named as an image whose bytes are not one: a file to download (its bytes are not text either).
  writeFileSync(join(w.project, "fake.png"), new Uint8Array([0x00, 0x01, 0x02]));
  // An HTML page named .svg is text, never an image.
  writeFileSync(join(w.project, "page.svg"), "<!doctype html><html><body>hi</body></html>");
  // Text under an unknown name is code; binary is a file; a document whose bytes are not text is a file.
  writeFileSync(join(w.project, "notes.unknownext"), "plain words\n");
  writeFileSync(join(w.project, "fixtures.zip"), new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff]));
  writeFileSync(join(w.project, "broken.md"), new Uint8Array([0x23, 0x20, 0x00, 0xff]));
  const recorded = await record(w, ["shot.png", "states.svg", "capture", "spec.pdf", "report.bin", "fake.png", "page.svg", "notes.unknownext", "fixtures.zip", "broken.md"]);
  expect(recorded.map((a) => [a.name, a.kind])).toEqual([
    ["shot.png", "image"],
    ["states.svg", "image"],
    ["capture", "image"],
    ["spec.pdf", "pdf"],
    ["report.bin", "pdf"],
    ["fake.png", "file"],
    ["page.svg", "code"],
    ["notes.unknownext", "code"],
    ["fixtures.zip", "file"],
    ["broken.md", "file"],
  ]);
  expect(recorded[0]).toMatchObject({ media_type: "image/png", width: 1280, height: 800 });
  expect(recorded[1]).toMatchObject({ media_type: "image/svg+xml" });
  expect(recorded[3]).toMatchObject({ media_type: "application/pdf" });
  expect(recorded[5]!.media_type).toBeUndefined();
});

test("documents keep their viewer by extension while their bytes are text", async () => {
  expect(decideInboxAttachmentKind("/r/plan.md", new Uint8Array(), true).kind).toBe("markdown");
  expect(decideInboxAttachmentKind("/r/page.html", new Uint8Array(), true).kind).toBe("html");
  expect(decideInboxAttachmentKind("/r/flow.mmd", new Uint8Array(), true).kind).toBe("mermaid");
  expect(decideInboxAttachmentKind("/r/ci.yaml", new Uint8Array(), true).kind).toBe("text");
  // A .txt that holds a PNG stays a document by its name only while it is text.
  expect(decideInboxAttachmentKind("/r/shot.txt", png(1, 1), false).kind).toBe("file");
});

test("a file outside the project is attached by its absolute path; a relative path resolves against the project", async () => {
  const w = world();
  const elsewhere = join(w.root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "shot.png"), png(4, 4));
  writeFileSync(join(w.root, "outside.ts"), "export {};\n");
  const recorded = await record(w, [join(elsewhere, "shot.png"), "../outside.ts"]);
  expect(recorded.map((a) => [a.path, a.kind])).toEqual([
    [join(elsewhere, "shot.png"), "image"],
    [join(w.root, "outside.ts"), "code"],
  ]);
});

test(".env is refused by name and through a symlink with another name; folders and FIFOs are refused; nothing of the send is written", async () => {
  const w = world();
  writeFileSync(join(w.project, ".env"), "SECRET=1\n");
  symlinkSync(join(w.project, ".env"), join(w.project, "load.sh"));
  writeFileSync(join(w.project, "notes.md"), "# Notes\n");
  await expect(record(w, [".env"])).rejects.toThrow(/\.env files are never attached/);
  await expect(record(w, ["notes.md", "load.sh"])).rejects.toThrow(/attachments\[1\]: load\.sh resolves to \.env/);
  writeFileSync(join(w.project, ".env.ts"), "export const KEY = 'secret';\n");
  writeFileSync(join(w.project, ".env.local"), "KEY=1\n");
  writeFileSync(join(w.project, ".env.example"), "KEY=\n");
  await expect(record(w, [".env.ts"])).rejects.toThrow(/\.env\.ts: \.env files are never attached/);
  await expect(record(w, [".env.local"])).rejects.toThrow(/never attached/);
  for (const name of ["prod.env", ".prod.env", ".envrc"]) {
    writeFileSync(join(w.project, name), "KEY=1\n");
    await expect(record(w, [name])).rejects.toThrow(/never attached/);
  }
  expect((await record(w, [".env.example"]))[0]?.kind).toBe("text");
  const blobsBefore = blobs(w);
  await expect(record(w, ["notes.md", "scripts"])).rejects.toThrow(/attachments\[1\]: .*a folder/);
  if (process.platform !== "win32") {
    spawnSync("mkfifo", [join(w.project, "pipe")]);
    await expect(record(w, ["notes.md", "pipe"])).rejects.toThrow(/not a regular file/);
  }
  expect(blobs(w)).toEqual(blobsBefore);
});

test("a large file streams through: its hash and size are right, and nothing else is left in the blob folder", async () => {
  const w = world();
  const big = new Uint8Array(5 * 1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  writeFileSync(join(w.project, "dump.bin"), big);
  const [attachment] = await record(w, ["dump.bin"]);
  expect(attachment!.kind).toBe("file");
  expect(attachment!.size).toBe(big.length);
  expect(attachment!.sent_sha256).toBe(createHash("sha256").update(big).digest("hex"));
  expect(blobs(w)).toEqual([attachment!.sent_sha256]);
});

test("the current file is re-hashed only when it changes; an image that stops being one reads as changed type, and the sent version still opens", async () => {
  const w = world();
  writeFileSync(join(w.project, "shot.png"), png(10, 10));
  const [attachment] = await record(w, ["shot.png"]);
  const state = await inboxAttachmentState(attachment!, "msg_x");
  expect(state.unavailable).toBeNull();
  expect(state.changed_since_sent).toBe(false);
  writeFileSync(join(w.project, "shot.png"), "now it is text");
  const changed = await inboxAttachmentState(attachment!, "msg_x");
  expect(changed.unavailable?.code).toBe("attachment_changed_type");
  const sent = await openInboxAttachmentVersion(w.inbox, attachment!, "sent");
  expect(sent.ok).toBe(true);
  if (sent.ok) await sent.handle.close();
  const current = await openInboxAttachmentVersion(w.inbox, attachment!, "current");
  expect(current.ok).toBe(false);
});

test("the current file is refused when its recorded path is of the dotenv family (the one check every route runs)", async () => {
  const w = world();
  writeFileSync(join(w.project, ".env"), "SECRET=1\n");
  const forged = {
    id: "att_01J0000000000000000000000A",
    path: join(w.project, ".env"),
    named_path: null,
    name: ".env",
    kind: "file" as const,
    sent_sha256: "0".repeat(64),
    size: 9,
    sent_at: w.at,
    sent_mtime: w.at,
  };
  expect((await inboxAttachmentState(forged, "msg_x")).unavailable?.code).toBe("attachment_changed_type");
  expect(await openInboxAttachmentVersion(w.inbox, forged, "current")).toMatchObject({ ok: false, code: "attachment_changed_type" });
  expect(await readInboxAttachmentText(w.inbox, forged, "current")).toMatchObject({ ok: false, code: "attachment_changed_type" });
});

test("a text or code file over the view limit is attached as a file (a download); this is not an attach cap", () => {
  const text = new TextEncoder().encode("line\n");
  expect(decideInboxAttachmentKind("/r/app.log", text, true, INBOX_VIEW_MAX_BYTES).kind).toBe("text");
  expect(decideInboxAttachmentKind("/r/app.log", text, true, INBOX_VIEW_MAX_BYTES + 1).kind).toBe("file");
  expect(decideInboxAttachmentKind("/r/bundle.js", text, true, INBOX_VIEW_MAX_BYTES + 1).kind).toBe("file");
  // Images and PDFs are never read whole as text, so size does not change them.
  expect(decideInboxAttachmentKind("/r/huge.png", png(9000, 9000), false, INBOX_VIEW_MAX_BYTES * 4).kind).toBe("image");
});

test("a text file that grew past the view limit after it was sent answers too large without being read; the sent version still reads", async () => {
  const w = world();
  writeFileSync(join(w.project, "app.log"), "started\n");
  const [attachment] = await record(w, ["app.log"]);
  expect(attachment!.kind).toBe("text");
  expect(await readInboxAttachmentText(w.inbox, attachment!, "current")).toMatchObject({ ok: true });
  appendFileSync(join(w.project, "app.log"), Buffer.alloc(INBOX_VIEW_MAX_BYTES, 0x61));
  const grown = await readInboxAttachmentText(w.inbox, attachment!, "current");
  expect(grown).toMatchObject({ ok: false, code: "attachment_too_large" });
  const sent = await readInboxAttachmentText(w.inbox, attachment!, "sent");
  expect(sent.ok && sent.bytes.toString("utf8")).toBe("started\n");
  // Listing judges the large changed file by its stat, without hashing it.
  const listed = await inboxAttachmentState(attachment!, "msg_x", { hash: "small" });
  expect(listed.changed_since_sent).toBe(true);
  expect(listed.current?.sha256.startsWith("stat:")).toBe(true);
});

test("sending a large file does not block the event loop", async () => {
  const w = world();
  writeFileSync(join(w.project, "big.bin"), Buffer.alloc(48 * 1024 * 1024, 0x01));
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 1);
  try {
    const [attachment] = await record(w, ["big.bin"]);
    expect(attachment!.size).toBe(48 * 1024 * 1024);
  } finally {
    clearInterval(timer);
  }
  // A blocking read loop would let no timer run until it finished.
  expect(ticks).toBeGreaterThan(3);
});

test("a send temp blob a crash left behind is swept once stale; a fresh one is kept", () => {
  const w = world();
  mkdirSync(inboxBlobsDir(w.inbox), { recursive: true });
  const stale = join(inboxBlobsDir(w.inbox), ".send.1.1.0.abc.tmp");
  const fresh = join(inboxBlobsDir(w.inbox), ".send.2.2.0.def.tmp");
  writeFileSync(stale, "partial");
  writeFileSync(fresh, "partial");
  const old = (Date.now() - STALE_SEND_TEMP_MS - 60_000) / 1000;
  utimesSync(stale, old, old);
  sweepStaleInboxSendTemps(w.inbox);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});
