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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxThreadArtifactRefs } from "@plannotator/core/inbox-artifact-pins";
import { inboxId, type InboxAttachment } from "@plannotator/core/inbox-types";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { captureInboxInlineImages } from "@plannotator/shared/inbox/inline-images";
import { InboxStore } from "@plannotator/shared/inbox/store";
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

  // The thread's artifacts: the picture, the film (the attached copy folded into it) and the recording; the html block is not a file.
  const refs = inboxThreadArtifactRefs([kept]);
  expect(refs.map((ref) => ref.key)).toEqual(kept.inline_images!.map((record) => record.id));
  expect(refs.every((ref) => ref.inline)).toBe(true);
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
