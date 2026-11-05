/**
 * Code review and Shape held until the next big release, 0.29 (owner decisions,
 * 2026-11-04 and 2026-11-05; inbox.ts `heldSwitch`). Until then their Settings →
 * Capabilities switches show only to a person who already has that feature on, or with PLANNOTATOR_INBOX_PREVIEW=1.
 * Settings draws a row only for a key the settings read carries, so the proof is
 * on the doors a window reads, on a real Inbox with config.json deciding:
 *
 *  - off and no preview: the settings read leaves both out, and a Checklist save's
 *    `event: capabilities` names neither (a window would otherwise merge them in);
 *  - already on: both are there; turning one off answers `{ on: false }` and tells
 *    every window, then the next read leaves it out;
 *  - PLANNOTATOR_INBOX_PREVIEW=1: both are there while off, in the read and the event;
 *  - a release build, 0.28.50 included: the same, as the hold reads no version.
 *
 * What regresses: a normal user seeing either switch before that release, or the
 * owner (on) losing the row, or a shown switch that cannot be turned off.
 * The next big release deletes this file with `heldSwitch`.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
const savedPreview = process.env.PLANNOTATOR_INBOX_PREVIEW;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  if (savedPreview === undefined) delete process.env.PLANNOTATOR_INBOX_PREVIEW;
  else process.env.PLANNOTATOR_INBOX_PREVIEW = savedPreview;
});

type Frame = { board?: { on: boolean }; steps?: { on: boolean }; code_review?: { on: boolean }; shape?: { on: boolean } };

async function world(config: Record<string, unknown> | null, preview: boolean, version?: string) {
  if (preview) process.env.PLANNOTATOR_INBOX_PREVIEW = "1";
  else delete process.env.PLANNOTATOR_INBOX_PREVIEW;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-held-switches-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false, ...(version ? { version, binaryPath: null } : {}) });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const read = async () => (await (await fetch(`${base}/api/inbox/settings`)).json()) as Frame;
  const save = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    return (await response.json()) as Frame;
  };
  return { base, read, save };
}

/** A window's event stream: the `event: capabilities` frames, as they arrive. */
async function windowCapabilities(base: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/inbox/events?window=held-switches-test`, { signal: controller.signal, headers: { "Sec-Fetch-Site": "same-origin" } });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let hello = false;
  let buffer = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        if (event === "hello") hello = true;
        if (event === "capabilities") frames.push(JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as Frame);
      }
    }
  })();
  const until = async (ready: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!ready()) {
      if (Date.now() > end) throw new Error("timed out waiting for the event stream");
      await Bun.sleep(5);
    }
  };
  await until(() => hello);
  return {
    frames,
    next: (count: number) => until(() => frames.length >= count),
    stop: async () => (controller.abort(), await pump),
  };
}

test("off, no preview: the settings read and a Checklist save's event leave Code review and Shape out", async () => {
  for (const config of [null, { inboxCodeReview: false, inboxShape: false }]) {
    const w = await world(config, false);
    const read = await w.read();
    expect(read.steps).toEqual({ on: false });
    expect("code_review" in read).toBe(false);
    expect("shape" in read).toBe(false);

    const stream = await windowCapabilities(w.base);
    const saved = await w.save({ steps: { on: true } });
    expect("code_review" in saved).toBe(false);
    expect("shape" in saved).toBe(false);
    await stream.next(1);
    expect(stream.frames).toEqual([{ board: { on: false }, steps: { on: true } }]);
    await stream.stop();
  }
});

test("already on: both rows' keys are there; turning each off answers off, tells the windows, then the read leaves it out", async () => {
  const w = await world({ inboxCodeReview: true, inboxShape: true }, false);
  const read = await w.read();
  expect(read.code_review).toEqual({ on: true });
  expect(read.shape).toEqual({ on: true });

  const stream = await windowCapabilities(w.base);
  expect((await w.save({ code_review: { on: false } })).code_review).toEqual({ on: false });
  await stream.next(1);
  expect(stream.frames[0]!.code_review).toEqual({ on: false });
  expect(stream.frames[0]!.shape).toEqual({ on: true });
  expect((await w.save({ shape: { on: false } })).shape).toEqual({ on: false });
  await stream.next(2);
  expect(stream.frames[1]).toEqual({ board: { on: false }, steps: { on: false }, shape: { on: false } });
  await stream.stop();

  const after = await w.read();
  expect("code_review" in after).toBe(false);
  expect("shape" in after).toBe(false);
});

test("PLANNOTATOR_INBOX_PREVIEW=1: both are there while off, in the read and in the windows' event", async () => {
  const w = await world(null, true);
  const read = await w.read();
  expect(read.code_review).toEqual({ on: false });
  expect(read.shape).toEqual({ on: false });

  const stream = await windowCapabilities(w.base);
  await w.save({ steps: { on: true } });
  await stream.next(1);
  expect(stream.frames).toEqual([{ board: { on: false }, steps: { on: true }, code_review: { on: false }, shape: { on: false } }]);
  await stream.stop();
});

test("a release build holds the same way: the hold reads no version, so 0.28.50 does not end it", async () => {
  for (const version of ["0.28.49", "0.28.50"]) {
    const off = await (await world({ updateCheck: false }, false, version)).read();
    expect("code_review" in off).toBe(false);
    expect("shape" in off).toBe(false);

    const on = await (await world({ updateCheck: false, inboxCodeReview: true, inboxShape: true }, false, version)).read();
    expect(on.code_review).toEqual({ on: true });
    expect(on.shape).toEqual({ on: true });

    const preview = await (await world({ updateCheck: false }, true, version)).read();
    expect(preview.code_review).toEqual({ on: false });
    expect(preview.shape).toEqual({ on: false });
  }
});
