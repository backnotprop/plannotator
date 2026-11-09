/**
 * Artifact pins (approval "inbox-artifact-stars"; the word is Pin): the
 * person's marks on a thread's artifacts, kept outside the event log. What can
 * regress: a pin writing a store line, a pin of something that is not one of
 * the thread's artifacts (another thread's file, the attached twin of an image
 * the text shows), the per-thread order (newest pin first), the file outliving
 * its thread, and artifact pins mixing with the sidebar's thread pins.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxId, type InboxAttachment } from "@plannotator/core/inbox-types";
import { INBOX_ARTIFACT_PINS_FILE } from "./artifact-pins";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function clock() {
  let t = Date.parse("2026-11-08T10:00:00.000Z");
  return () => new Date((t += 1000));
}

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-artifact-pin-"));
  roots.push(dir);
  const now = clock();
  const store = InboxStore.open(dir, { now });
  const project = store.ensureProject({ name: "repo", root: "/work/repo" });
  return { dir, now, store, project };
}

const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });

function file(name: string, path = `/work/repo/${name}`, kind: InboxAttachment["kind"] = "markdown"): InboxAttachment {
  const at = new Date().toISOString();
  return { id: inboxId("att"), path, named_path: null, name, kind, sent_sha256: "0".repeat(64), size: 10, sent_at: at, sent_mtime: at };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

function lines(dir: string): number {
  // Every store line: count them all.
  const glob = new Bun.Glob("inbox/**/*.jsonl");
  let n = 0;
  for (const path of glob.scanSync({ cwd: dir })) n += readFileSync(join(dir, path), "utf8").split("\n").filter(Boolean).length;
  return n;
}

describe("artifact pins in the store", () => {
  test("pin and unpin; the thread's pins come newest pin first; no store line is written", () => {
    const { dir, store, project } = open();
    const a = file("plan.md");
    const b = file("notes.md");
    const c = file("diagram.mmd", undefined, "mermaid");
    const root = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Files", attachments: [a, b] }).message;
    store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "One more", attachments: [c], reply_to: root.id });
    const before = lines(dir);
    expect(before).toBeGreaterThan(0);
    store.setArtifactPinned(root.thread_id, b.id, true);
    store.setArtifactPinned(root.thread_id, c.id, true);
    store.setArtifactPinned(root.thread_id, a.id, true);
    expect(store.threadArtifactPins(root.thread_id).map((p) => p.key)).toEqual([a.id, c.id, b.id]);
    // Pinning again changes nothing (the place and the time stay).
    const at = store.artifactPins().find((p) => p.key === b.id)!.pinned_at;
    store.setArtifactPinned(root.thread_id, b.id, true);
    expect(store.artifactPins().find((p) => p.key === b.id)!.pinned_at).toBe(at);
    store.setArtifactPinned(root.thread_id, c.id, false);
    expect(store.threadArtifactPins(root.thread_id).map((p) => p.key)).toEqual([a.id, b.id]);
    // Unpinning what is not pinned changes nothing.
    store.setArtifactPinned(root.thread_id, c.id, false);
    expect(store.artifactPins()).toHaveLength(2);
    expect(lines(dir)).toBe(before);
    // Not the sidebar's thread pins.
    expect(store.pins()).toEqual([]);
    expect(existsSync(join(dir, "inbox", "pins.json"))).toBe(false);
  });

  test("each thread keeps its own pins and order", () => {
    const { store, project } = open();
    const x1 = file("x1.md");
    const x2 = file("x2.md");
    const y1 = file("y1.md");
    const x = store.sendMessage({ project_id: project.id, author: agent("ses_x"), thread: "x", body: "X", attachments: [x1, x2] }).message;
    const y = store.sendMessage({ project_id: project.id, author: agent("ses_y"), thread: "y", body: "Y", attachments: [y1] }).message;
    expect(x.thread_id).not.toBe(y.thread_id);
    store.setArtifactPinned(x.thread_id, x1.id, true);
    store.setArtifactPinned(y.thread_id, y1.id, true);
    store.setArtifactPinned(x.thread_id, x2.id, true);
    expect(store.threadArtifactPins(x.thread_id).map((p) => p.key)).toEqual([x2.id, x1.id]);
    expect(store.threadArtifactPins(y.thread_id).map((p) => p.key)).toEqual([y1.id]);
    // Pin order across threads: the oldest first.
    expect(store.artifactPins().map((p) => p.key)).toEqual([x1.id, y1.id, x2.id]);
  });

  test("only the thread's own artifacts can be pinned; a bad key or thread is refused", () => {
    const { store, project } = open();
    const mine = file("mine.md");
    const other = file("other.md");
    const root = store.sendMessage({ project_id: project.id, author: agent("ses_a"), thread: "a", body: "Mine", attachments: [mine] }).message;
    const reply = store.sendMessage({ project_id: project.id, author: agent("ses_a"), thread: "a", body: "Again" }).message;
    const elsewhere = store.sendMessage({ project_id: project.id, author: agent("ses_b"), thread: "b", body: "Other", attachments: [other] }).message;
    expect(code(() => store.setArtifactPinned(root.thread_id, other.id, true))).toBe("artifact_not_found");
    expect(code(() => store.setArtifactPinned(root.thread_id, `guide:${root.id}`, true))).toBe("artifact_not_found");
    expect(code(() => store.setArtifactPinned(root.thread_id, "../etc/passwd", true))).toBe("validation_error");
    expect(code(() => store.setArtifactPinned(reply.id, mine.id, true))).toBe("thread_not_found");
    expect(code(() => store.setArtifactPinned(elsewhere.thread_id, other.id, true))).toBe("ok");
    expect(store.artifactPins().map((p) => p.key)).toEqual([other.id]);
  });

  test("an image both shown in the text and attached is one artifact, under the shown image's id", () => {
    const { store, project } = open();
    const attached = file("shot.png", "/work/repo/shot.png", "image");
    const root = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "![shot](shot.png)", attachments: [attached] }).message;
    const shown = { ...file("shot.png", "/work/repo/shot.png", "image"), ref: "shot.png" };
    store.addCapturedImages(root.id, [shown]);
    expect(store.threadArtifactRefs(root.thread_id).map((r) => r.key)).toEqual([shown.id]);
    expect(code(() => store.setArtifactPinned(root.thread_id, attached.id, true))).toBe("artifact_not_found");
    expect(code(() => store.setArtifactPinned(root.thread_id, shown.id, true))).toBe("ok");
  });

  test("pins outlive a restart, and a deleted thread's pins leave the file on the next load", () => {
    const { dir, now, store, project } = open();
    const keep = file("keep.md");
    const gone = file("gone.md");
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_a"), thread: "a", body: "Keep", attachments: [keep] }).message;
    const b = store.sendMessage({ project_id: project.id, author: agent("ses_b"), thread: "b", body: "Gone", attachments: [gone] }).message;
    store.setArtifactPinned(a.thread_id, keep.id, true);
    store.setArtifactPinned(b.thread_id, gone.id, true);
    const again = InboxStore.open(dir, { now });
    expect(again.artifactPins().map((p) => p.key)).toEqual([keep.id, gone.id]);
    let told = 0;
    again.onArtifactPinsChange(() => (told += 1));
    again.deleteThread(b.thread_id);
    expect(again.artifactPins().map((p) => p.key)).toEqual([keep.id]);
    expect(told).toBeGreaterThan(0);
    const onDisk = JSON.parse(readFileSync(join(dir, "inbox", INBOX_ARTIFACT_PINS_FILE), "utf8")) as { pins: { key: string }[] };
    expect(onDisk.pins.map((p) => p.key)).toEqual([keep.id]);
  });

  test("a file from a newer Plannotator is never written over; an unreadable one is moved aside", () => {
    const { dir, store, project } = open();
    const f = file("f.md");
    const root = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "F", attachments: [f] }).message;
    writeFileSync(join(dir, "inbox", INBOX_ARTIFACT_PINS_FILE), JSON.stringify({ v: 2, pins: [] }));
    expect(code(() => store.setArtifactPinned(root.thread_id, f.id, true))).toBe("artifact_pins_newer");
    expect(JSON.parse(readFileSync(join(dir, "inbox", INBOX_ARTIFACT_PINS_FILE), "utf8")).v).toBe(2);
    writeFileSync(join(dir, "inbox", INBOX_ARTIFACT_PINS_FILE), "not json");
    expect(code(() => store.setArtifactPinned(root.thread_id, f.id, true))).toBe("ok");
    expect(store.artifactPins().map((p) => p.key)).toEqual([f.id]);
  });
});
