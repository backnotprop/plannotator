/**
 * Sounds and videos a message's text plays in place are artifacts of the
 * thread, as its pictures are: a later read's capture keeps each as a file of
 * the thread (`inline_images`, kind `video` / `audio`), so the thread's
 * artifact list (`inboxThreadArtifactRefs`, what the Wall and the pins use;
 * the window's grid reads the same records) holds it. What can regress: a
 * film left out of the list, out of text order, counted twice when it is also
 * attached, a new id (or a new store line) on every read, its pin refused or
 * lost, a send that starts copying films (the send's list stays pictures),
 * and a film turning up as a question card's picture.
 *
 * In-process only: a store under a temp folder and the capture queue, no
 * Inbox server and no network.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxThreadArtifactRefs } from "@plannotator/core/inbox-artifact-pins";
import { inboxHtmlArtifactKey, inboxHtmlBlockHash } from "@plannotator/core/inbox-html-blocks";
import { inboxId, type InboxAttachment } from "@plannotator/core/inbox-types";
import { inboxBlobPath, inboxBlobsDir, writeBlob } from "@plannotator/shared/inbox/attachments";
import { captureInboxInlineImages } from "@plannotator/shared/inbox/inline-images";
import { captureInboxInlineMedia } from "@plannotator/shared/inbox/inline-media-capture";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxArtifactsPage, inboxWallEntries } from "./inbox-artifact-pins";
import { createInboxImageCapture } from "./inbox-message-images";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** An MP4 by its `ftyp` brands, then some film bytes (no `moov`: its length and size are unknown). */
function mp4(): Buffer {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftypisom", 4, "latin1");
  ftyp.write("isomavc1", 16, "latin1");
  return Buffer.concat([ftyp, Buffer.alloc(4096, 7)]);
}

function wav(): Buffer {
  const out = Buffer.alloc(44);
  out.write("RIFF", 0, "latin1");
  out.write("WAVEfmt ", 8, "latin1");
  out.write("data", 36, "latin1");
  return out;
}

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inline-media-")));
  const project = join(base, "harbor");
  const dataDir = join(base, "data");
  mkdirSync(project, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(project, "berth.png"), PNG);
  writeFileSync(join(project, "walkthrough.mp4"), mp4());
  writeFileSync(join(project, "standup.wav"), wav());
  let t = Date.parse("2026-11-24T10:00:00.000Z");
  const now = () => new Date((t += 1000));
  const store = InboxStore.open(dataDir, { now });
  const repo = store.ensureProject({ name: "harbor", root: project });
  return { project, dataDir, now, store, repo };
}

const agent = { kind: "agent" as const, host: "claude-code", session: "ses_harbor", name: "Claude Code" };

function attached(path: string, name: string, kind: InboxAttachment["kind"]): InboxAttachment {
  const at = new Date().toISOString();
  return { id: inboxId("att"), path, named_path: null, name, kind, sent_sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), size: readFileSync(path).length, sent_at: at, sent_mtime: at };
}

const BODY = ["The berth plan:", "", "![Berth plan](berth.png)", "", "The walkthrough:", "", "![Walkthrough](walkthrough.mp4)", "", "And the standup:", "", "![Standup](standup.wav)", "", "```html", "<p>Tide table</p>", "```"].join("\n");

test("a read captures the text's sound and video as files of the thread: artifacts in text order, an attached twin counted once", async () => {
  const { project, store, repo } = world();
  const twin = attached(join(project, "walkthrough.mp4"), "walkthrough.mp4", "video");
  const message = store.sendMessage({ project_id: repo.id, author: agent, body: BODY, attachments: [twin] }).message;
  const capture = createInboxImageCapture(store);
  capture.schedule(message.thread_id);
  await capture.idle();

  const kept = store.message(message.id)!;
  expect((kept.inline_images ?? []).map((record) => [record.ref, record.kind])).toEqual([
    ["berth.png", "image"],
    ["walkthrough.mp4", "video"],
    ["standup.wav", "audio"],
  ]);
  const film = kept.inline_images![1]!;
  expect(film.media_type).toBe("video/mp4");
  expect(film.path).toBe(join(project, "walkthrough.mp4"));
  expect(film.captured).toBe("on_open");
  // The Inbox's own copy: the sent version opens even once the file is gone.
  expect(readFileSync(inboxBlobPath(store.dir, film.sent_sha256))).toEqual(mp4());

  // The thread's artifacts: the picture, the film (the attached copy folded into it) and the recording, then the html
  // block (not a file: no record, its key its message's and its source's).
  const refs = inboxThreadArtifactRefs([kept]);
  expect(refs.map((ref) => ref.key)).toEqual([...kept.inline_images!.map((record) => record.id), inboxHtmlArtifactKey(kept.id, inboxHtmlBlockHash("<p>Tide table</p>"))]);
  expect(refs.every((ref) => ref.inline)).toBe(true);
  expect(refs.at(-1)!.attachment).toBeNull();
  capture.stop();
});

test("the same ids on every read, no new store line, and a film's pin is taken and kept across a restart", async () => {
  const { dataDir, now, store, repo } = world();
  const message = store.sendMessage({ project_id: repo.id, author: agent, body: BODY }).message;
  const capture = createInboxImageCapture(store);
  capture.schedule(message.thread_id);
  await capture.idle();
  const first = store.message(message.id)!.inline_images!.map((record) => record.id);
  const version = store.threadVersion(message.thread_id);

  capture.schedule(message.thread_id);
  await capture.idle();
  expect(store.message(message.id)!.inline_images!.map((record) => record.id)).toEqual(first);
  expect(store.threadVersion(message.thread_id)).toBe(version);
  capture.stop();

  store.setArtifactPinned(message.thread_id, first[1]!, true);
  const reopened = InboxStore.open(dataDir, { now });
  expect(reopened.threadArtifactPins(message.thread_id).map((pin) => pin.key)).toEqual([first[1]!]);
});

test("a film pinned while only its attached copy was an artifact keeps its pin once a read captures the copy its text plays", async () => {
  const { project, dataDir, now, store, repo } = world();
  const twin = attached(join(project, "walkthrough.mp4"), "walkthrough.mp4", "video");
  const message = store.sendMessage({ project_id: repo.id, author: agent, body: BODY, attachments: [twin] }).message;
  // Before any read: the attached film is the artifact.
  expect(inboxThreadArtifactRefs([store.message(message.id)!]).map((ref) => ref.key)).toContain(twin.id);
  store.setArtifactPinned(message.thread_id, twin.id, true);

  const capture = createInboxImageCapture(store);
  capture.schedule(message.thread_id);
  await capture.idle();
  capture.stop();
  const film = store.message(message.id)!.inline_images!.find((record) => record.ref === "walkthrough.mp4")!;
  // One artifact now, under the shown record's id, and the pin is on it: in the thread's Pinned group and on the Wall.
  expect(store.threadArtifactPins(message.thread_id).map((pin) => pin.key)).toEqual([film.id]);
  const wall = inboxWallEntries(store, false).filter((entry) => entry.pinnedAt !== null);
  expect(wall.map((entry) => entry.ref.key)).toEqual([film.id]);
  expect(InboxStore.open(dataDir, { now }).threadArtifactPins(message.thread_id).map((pin) => pin.key)).toEqual([film.id]);
});

test("a pin made on the captured film (attached as well) is kept across a restart, and the attached id unpins it", async () => {
  const { project, dataDir, now, store, repo } = world();
  const twin = attached(join(project, "walkthrough.mp4"), "walkthrough.mp4", "video");
  const message = store.sendMessage({ project_id: repo.id, author: agent, body: BODY, attachments: [twin] }).message;
  const capture = createInboxImageCapture(store);
  capture.schedule(message.thread_id);
  await capture.idle();
  capture.stop();
  const film = store.message(message.id)!.inline_images!.find((record) => record.ref === "walkthrough.mp4")!;
  store.setArtifactPinned(message.thread_id, film.id, true);
  const reopened = InboxStore.open(dataDir, { now });
  expect(reopened.threadArtifactPins(message.thread_id).map((pin) => pin.key)).toEqual([film.id]);
  // A window that read the thread before the capture still names the attached copy: the same artifact.
  reopened.setArtifactPinned(message.thread_id, twin.id, false);
  expect(reopened.artifactPins()).toEqual([]);
});

test("a film the message also attached, unchanged, names the attached copy's blob: nothing is copied again", async () => {
  const { project, store, repo } = world();
  const path = join(project, "walkthrough.mp4");
  const stat = statSync(path);
  // The attached copy's blob under its own hash: what the record names shows whether the capture read the file again.
  const sent = Buffer.concat([mp4(), Buffer.from("as sent")]);
  const sentHash = createHash("sha256").update(sent).digest("hex");
  writeBlob(store.dir, sentHash, sent);
  const twin: InboxAttachment = { ...attached(path, "walkthrough.mp4", "video"), sent_sha256: sentHash, sent_mtime: stat.mtime.toISOString(), media_type: "video/mp4" };
  const message = store.sendMessage({ project_id: repo.id, author: agent, body: BODY, attachments: [twin] }).message;
  const capture = createInboxImageCapture(store);
  capture.schedule(message.thread_id);
  await capture.idle();
  capture.stop();
  const film = store.message(message.id)!.inline_images!.find((record) => record.ref === "walkthrough.mp4")!;
  expect(film.kind).toBe("video");
  expect(film.sent_sha256).toBe(sentHash);
  expect(existsSync(inboxBlobPath(store.dir, createHash("sha256").update(mp4()).digest("hex")))).toBe(false);

  // Changed since it was attached (another mtime): copied as its own file.
  const later = world();
  writeBlob(later.store.dir, sentHash, sent);
  const laterTwin: InboxAttachment = { ...attached(join(later.project, "walkthrough.mp4"), "walkthrough.mp4", "video"), sent_sha256: sentHash, sent_mtime: "2026-01-01T00:00:00.000Z" };
  const laterMessage = later.store.sendMessage({ project_id: later.repo.id, author: agent, body: BODY, attachments: [laterTwin] }).message;
  const laterCapture = createInboxImageCapture(later.store);
  laterCapture.schedule(laterMessage.thread_id);
  await laterCapture.idle();
  laterCapture.stop();
  const copied = later.store.message(laterMessage.id)!.inline_images!.find((record) => record.ref === "walkthrough.mp4")!;
  expect(copied.sent_sha256).toBe(createHash("sha256").update(mp4()).digest("hex"));
});

test("a film past the cap while it is copied is refused, and no partial copy is left beside the blobs", async () => {
  const { project, store } = world();
  const result = await captureInboxInlineMedia(store.dir, { body: BODY, root: project, base: null, path: "walkthrough.mp4", anywhere: true, sentAt: new Date().toISOString(), maxBytes: 1024 });
  expect(result).toEqual({ ok: false, code: "image_too_large" });
  const blobs = inboxBlobsDir(store.dir);
  expect(existsSync(blobs) ? readdirSync(blobs).filter((name) => name.endsWith(".tmp")) : []).toEqual([]);
});

test("a copy that could not be written waits the long wait, not the minute's retry, while the thread stays open", async () => {
  const { store, repo } = world();
  const message = store.sendMessage({ project_id: repo.id, author: agent, body: "![Walkthrough](walkthrough.mp4)" }).message;
  let t = 1_000_000;
  const reads: string[] = [];
  const capture = createInboxImageCapture(store, {
    now: () => t,
    retryMs: 60_000,
    missWaitsMs: [30_000, 120_000, 600_000],
    capture: async (_dir, input) => {
      reads.push(...(input.refs ?? []));
      return { images: [], failures: (input.refs ?? []).map((ref) => ({ ref, code: "write_failed" })), bytes: 0, commit: async () => {}, discard: async () => {} };
    },
  });
  const read = async () => {
    capture.schedule(message.thread_id);
    await capture.idle();
  };
  await read();
  expect(reads).toEqual(["walkthrough.mp4"]);
  t += 61_000;
  await read();
  // The thread changing (a reply) does not end the wait either.
  store.sendMessage({ project_id: repo.id, author: agent, body: "Still copying?", reply_to: message.id });
  await read();
  expect(reads).toEqual(["walkthrough.mp4"]);
  t += 600_000;
  await read();
  expect(reads).toEqual(["walkthrough.mp4", "walkthrough.mp4"]);
  capture.stop();
});

test("a body with no picture, sound or video gets no records; the send's own capture still takes pictures only", async () => {
  const { project, store, repo } = world();
  const plain = store.sendMessage({ project_id: repo.id, author: agent, body: "Fern API is green; nothing to look at." }).message;
  const capture = createInboxImageCapture(store);
  capture.schedule(plain.thread_id);
  await capture.idle();
  expect(store.message(plain.id)!.inline_images).toBeUndefined();
  expect(inboxThreadArtifactRefs([store.message(plain.id)!])).toEqual([]);
  capture.stop();

  // What send_message runs (no `refs`): the picture, never the film or the recording.
  const atSend = await captureInboxInlineImages(store.dir, { body: BODY, root: project, anywhere: true, sentAt: new Date().toISOString() });
  expect(atSend.images.map((record) => record.ref)).toEqual(["berth.png"]);
  expect(atSend.failures).toEqual([]);
});

test("a question's card never takes a film the message plays as one of its pictures", async () => {
  const { store, repo } = world();
  const body = `${BODY}\n\n:::question\nShip the walkthrough?\n- Yes\n- No\n:::`;
  const message = store.sendMessage({ project_id: repo.id, author: agent, body }).message;
  const capture = createInboxImageCapture(store);
  capture.schedule(message.thread_id);
  await capture.idle();
  capture.stop();
  const decision = store.openDecisions().find((d) => d.message.id === message.id);
  expect(decision).toBeDefined();
  expect(decision!.pictures.inline.map((picture) => picture.ref)).toEqual(["berth.png"]);
});

const TIDES = "<h2>Harbor · tide table</h2>\n<table><tr><td>06:12</td><td>12:30</td></tr></table>";
const BERTHS = '<div id="chart"></div>\n<script src="https://cdn.example/chart.js"></script>';
const TWO_BLOCKS = ["The berth plan:", "", "![Berth plan](berth.png)", "", "![Walkthrough](walkthrough.mp4)", "", "```html", TIDES, "```", "", "```html", BERTHS, "```"].join("\n");

test("an agent's html blocks are artifacts beside its picture and film: in the text, their own keys, the Wall's words", async () => {
  const { store, repo } = world();
  const message = store.sendMessage({ project_id: repo.id, author: agent, body: TWO_BLOCKS }).message;
  const capture = createInboxImageCapture(store);
  capture.schedule(message.thread_id);
  await capture.idle();
  capture.stop();
  const kept = store.message(message.id)!;
  const tides = inboxHtmlArtifactKey(kept.id, inboxHtmlBlockHash(TIDES));
  const berths = inboxHtmlArtifactKey(kept.id, inboxHtmlBlockHash(BERTHS));
  const refs = store.threadArtifactRefs(message.thread_id);
  expect(refs.map((ref) => ref.key)).toEqual([...kept.inline_images!.map((record) => record.id), tides, berths]);
  expect(refs.map((ref) => ref.attachment?.kind ?? (ref.html ? "html" : null))).toEqual(["image", "video", "html", "html"]);
  expect(refs.every((ref) => ref.inline)).toBe(true);
  // A second read: the same keys.
  expect(store.threadArtifactRefs(message.thread_id).map((ref) => ref.key)).toEqual(refs.map((ref) => ref.key));

  // The Wall lists them as pages, with the page's heading (or none) and size; the page itself never travels there.
  const page = await inboxArtifactsPage(store, new URL("http://127.0.0.1/api/inbox/artifacts"));
  const rows = page.artifacts.filter((row) => row.key.startsWith("html:"));
  expect(rows.map((row) => [row.key, row.type, row.html, row.attachment])).toEqual([
    [tides, "pages", { title: "Harbor · tide table", size: Buffer.byteLength(TIDES) }, null],
    [berths, "pages", { title: null, size: Buffer.byteLength(BERTHS) }, null],
  ]);
  expect(page.counts.types.pages).toBe(2);
  expect(JSON.stringify(rows)).not.toContain("chart.js");

  // The person's own text (it quotes what it answers) holds no artifact.
  const reply = store.sendMessage({ project_id: repo.id, author: { kind: "person" }, body: "```html\n<p>pasted</p>\n```", reply_to: message.id }).message;
  expect(inboxThreadArtifactRefs([store.message(reply.id)!])).toEqual([]);
});

test("a pin on an html block is taken, kept across a restart and a reread, and a block that is not there is refused", async () => {
  const { dataDir, now, store, repo } = world();
  const message = store.sendMessage({ project_id: repo.id, author: agent, body: TWO_BLOCKS }).message;
  const berths = inboxHtmlArtifactKey(message.id, inboxHtmlBlockHash(BERTHS));
  store.setArtifactPinned(message.thread_id, berths, true);
  // A read that captures the film adds records to the message: the block's pin stays.
  const capture = createInboxImageCapture(store);
  capture.schedule(message.thread_id);
  await capture.idle();
  capture.stop();
  expect(store.threadArtifactPins(message.thread_id).map((pin) => pin.key)).toEqual([berths]);
  const reopened = InboxStore.open(dataDir, { now });
  expect(reopened.threadArtifactPins(message.thread_id).map((pin) => pin.key)).toEqual([berths]);
  expect(inboxWallEntries(reopened, false).filter((entry) => entry.pinnedAt !== null).map((entry) => entry.ref.key)).toEqual([berths]);
  let code = "ok";
  try {
    reopened.setArtifactPinned(message.thread_id, inboxHtmlArtifactKey(message.id, inboxHtmlBlockHash("<p>never sent</p>")), true);
  } catch (error) {
    code = (error as { code?: string }).code ?? "thrown";
  }
  expect(code).toBe("artifact_not_found");
  reopened.setArtifactPinned(message.thread_id, berths, false);
  expect(reopened.artifactPins()).toEqual([]);
});
