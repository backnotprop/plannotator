/**
 * The on-open capture of a message's images (createInboxImageCapture) and an image not on disk (#2788): an agent
 * may name a path anywhere, a sleeping disk or an automount included, and each read of it holds the Inbox. A source
 * refused before any read waits INBOX_IMAGE_CAPTURE_MISS_WAITS_MS before it is read again, however often its thread
 * is opened; one that appears is captured once its wait passes, at once when the image route serves it (the
 * window draws it), or on the next open after its thread changed (a new message: the window does not ask the route
 * again for a picture that failed); the table of waits is bounded. A real store over a temp data dir; no Inbox is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { captureInboxInlineImages } from "@plannotator/shared/inbox/inline-images";
import { INBOX_IMAGE_CAPTURE_MISS_WAITS_MS, createInboxImageCapture, inboxMessageImageRoute } from "./inbox-message-images";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

/** A PNG's signature and IHDR: enough for the sniffer and the dimension read. */
function png(salt = 0): Uint8Array {
  const bytes = new Uint8Array(34);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0]);
  bytes[33] = salt;
  return bytes;
}

function world(options: { maxMessages?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-capture-waits-")));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "shop");
  mkdirSync(join(project, "shots"), { recursive: true });
  const clock = { now: Date.parse("2026-11-21T10:00:00.000Z") };
  const store = InboxStore.open(join(root, "data"));
  const { id: projectId } = store.ensureProject({ name: "shop", root: project });
  /** Each capture's sources: every one is a realpath, a stat and an open in the person's folders. */
  const reads: string[] = [];
  /** Runs after a capture read, before its refusals are noted (what happens meanwhile). */
  const during: { then: (() => Promise<void>) | null } = { then: null };
  const capture = createInboxImageCapture(store, {
    now: () => clock.now,
    ...(options.maxMessages ? { maxMessages: options.maxMessages } : {}),
    capture: async (dir, input) => {
      reads.push(...(input.refs ?? []));
      const result = await captureInboxInlineImages(dir, input);
      const then = during.then;
      during.then = null;
      await then?.();
      return result;
    },
  });
  let scans = 0;
  const gaps = store.imageCaptureGaps.bind(store);
  store.imageCaptureGaps = (...args) => ((scans += 1), gaps(...args));
  restore.push(() => capture.stop());
  let n = 0;
  const send = (body: string) =>
    store.sendMessage({ project_id: projectId, author: { kind: "agent", host: "claude-code", session: "s-1", name: "Claude" }, body, idempotency_key: `k-${++n}` }).message;
  /** The window opens the thread: the read schedules the capture, which runs in the background. */
  const open = async (threadId: string) => {
    capture.schedule(threadId);
    await capture.idle();
  };
  const captured = (id: string) => (store.message(id)!.inline_images ?? []).map((image) => image.ref);
  return { project, clock, store, capture, reads, during, send, open, captured, scans: () => scans };
}

describe("an image not on disk", () => {
  test("is read once, not again on the thread's next opens until its wait passes; then it is captured", async () => {
    const w = world();
    const message = w.send("Soon:\n\n![after](shots/after.png)");
    await w.open(message.thread_id);
    expect(w.reads).toEqual(["shots/after.png"]);

    // Opened again and again, minutes of them under the wait: nothing is read.
    for (let i = 0; i < 20; i++) {
      w.clock.now += 1_000;
      await w.open(message.thread_id);
    }
    expect(w.reads).toHaveLength(1);
    // The thread settled: an open of it does not even look at its messages again.
    const scans = w.scans();
    await w.open(message.thread_id);
    expect(w.scans()).toBe(scans);

    // Still not there when the wait passes: read once more, then the next, longer, wait.
    w.clock.now += INBOX_IMAGE_CAPTURE_MISS_WAITS_MS[0]!;
    await w.open(message.thread_id);
    await w.open(message.thread_id);
    expect(w.reads).toHaveLength(2);
    w.clock.now += INBOX_IMAGE_CAPTURE_MISS_WAITS_MS[0]!;
    await w.open(message.thread_id);
    expect(w.reads).toHaveLength(2);

    // Written later: captured once the wait passes, never given up on.
    writeFileSync(join(w.project, "shots", "after.png"), png(1));
    w.clock.now += INBOX_IMAGE_CAPTURE_MISS_WAITS_MS[1]!;
    await w.open(message.thread_id);
    expect(w.captured(message.id)).toEqual(["shots/after.png"]);
    expect(w.reads).toHaveLength(3);
  });

  test("the waits grow to the last and stay there", async () => {
    const w = world();
    const message = w.send("![x](shots/x.png)");
    const times: number[] = [];
    const start = w.clock.now;
    // An hour, opened every 10 s.
    for (let t = 0; t <= 60 * 60_000; t += 10_000) {
      w.clock.now = start + t;
      const before = w.reads.length;
      await w.open(message.thread_id);
      if (w.reads.length > before) times.push(t);
    }
    const last = INBOX_IMAGE_CAPTURE_MISS_WAITS_MS.at(-1)!;
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps.slice(0, INBOX_IMAGE_CAPTURE_MISS_WAITS_MS.length)).toEqual([...INBOX_IMAGE_CAPTURE_MISS_WAITS_MS]);
    expect(gaps.slice(INBOX_IMAGE_CAPTURE_MISS_WAITS_MS.length).every((gap) => gap === last)).toBe(true);
    expect(times.length).toBeLessThan(12);
  });

  test("written later, then the thread takes a new message: captured on the next open, not after the wait", async () => {
    const w = world();
    const message = w.send("Soon:\n\n![after](shots/after.png)");
    await w.open(message.thread_id);
    expect(w.reads).toEqual(["shots/after.png"]);
    // The window keeps the thread open; its broken picture is not asked for again, so the route never serves it.
    writeFileSync(join(w.project, "shots", "after.png"), png(4));
    w.clock.now += 1_000;
    w.store.sendMessage({ project_id: w.store.message(message.id)!.project_id, author: { kind: "agent", host: "claude-code", session: "s-1", name: "Claude" }, body: "One more note.", reply_to: message.id, idempotency_key: "k-note" });
    await w.open(message.thread_id);
    expect(w.captured(message.id)).toEqual(["shots/after.png"]);
  });

  test("a new message that came while the capture that missed it was still running: the next open captures it", async () => {
    const w = world();
    const message = w.send("![after](shots/after.png)");
    w.during.then = async () => {
      writeFileSync(join(w.project, "shots", "after.png"), png(5));
      w.store.sendMessage({ project_id: w.store.message(message.id)!.project_id, author: { kind: "agent", host: "claude-code", session: "s-1", name: "Claude" }, body: "Written now.", reply_to: message.id, idempotency_key: "k-note" });
    };
    await w.open(message.thread_id);
    expect(w.captured(message.id)).toEqual([]);
    await w.open(message.thread_id);
    expect(w.captured(message.id)).toEqual(["shots/after.png"]);
  });

  test("still missing when the thread changes: read once for the change, then it waits again", async () => {
    const w = world();
    const message = w.send("![after](shots/after.png)");
    await w.open(message.thread_id);
    w.clock.now += 1_000;
    w.store.sendMessage({ project_id: w.store.message(message.id)!.project_id, author: { kind: "agent", host: "claude-code", session: "s-1", name: "Claude" }, body: "No picture yet.", reply_to: message.id, idempotency_key: "k-note" });
    for (let i = 0; i < 10; i++) {
      w.clock.now += 1_000;
      await w.open(message.thread_id);
    }
    expect(w.reads).toEqual(["shots/after.png", "shots/after.png"]);
  });

  test("the image route serving it ends the wait: captured at once, as the window draws it", async () => {
    const w = world();
    const message = w.send("![after](shots/after.png)");
    await w.open(message.thread_id);
    expect(w.captured(message.id)).toEqual([]);
    writeFileSync(join(w.project, "shots", "after.png"), png(2));
    const url = new URL(`http://127.0.0.1/api/inbox/messages/${message.id}/image?path=${encodeURIComponent("shots/after.png")}`);
    const answer = await inboxMessageImageRoute(new Request(url), url, w.store, w.capture.shown);
    expect(answer?.status).toBe(200);
    await w.capture.idle();
    expect(w.captured(message.id)).toEqual(["shots/after.png"]);
  });

  test("served by the route while a capture that found nothing was still running: no wait", async () => {
    const w = world();
    const message = w.send("![after](shots/after.png)");
    const url = new URL(`http://127.0.0.1/api/inbox/messages/${message.id}/image?path=${encodeURIComponent("shots/after.png")}`);
    w.during.then = async () => {
      writeFileSync(join(w.project, "shots", "after.png"), png(3));
      expect((await inboxMessageImageRoute(new Request(url), url, w.store, w.capture.shown))?.status).toBe(200);
    };
    await w.open(message.thread_id);
    expect(w.captured(message.id)).toEqual(["shots/after.png"]);
  });

  test("the waits are remembered for a bounded number of messages, the least recently tried forgotten first", async () => {
    const w = world({ maxMessages: 2 });
    const [a, b, c] = ["a", "b", "c"].map((name) => w.send(`![${name}](shots/${name}.png)`));
    for (const message of [a!, b!, c!]) await w.open(message.thread_id);
    expect(w.reads).toEqual(["shots/a.png", "shots/b.png", "shots/c.png"]);
    // b and c are remembered: nothing read. a was dropped, so it is read again (sooner, never later, than its wait).
    for (const message of [b!, c!]) await w.open(message.thread_id);
    expect(w.reads).toHaveLength(3);
    await w.open(a!.thread_id);
    expect(w.reads).toEqual(["shots/a.png", "shots/b.png", "shots/c.png", "shots/a.png"]);
  });
});
