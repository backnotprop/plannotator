/**
 * Code review and Shape were held back from 0.28.49 (owner decisions, 2026-11-04 and 2026-11-05). On 2026-11-17 the
 * owner let Code review's Settings → Capabilities switch show to everyone ("keep code review, no need for the code
 * review dialogue, but enable it in the capabilities"); Shape stays held (inbox.ts `heldSwitch`): its switch shows
 * only to a person who already has Shape on, or with PLANNOTATOR_INBOX_PREVIEW=1. Settings draws a row only for a key
 * the settings read carries, so the proof is on the doors a window reads, on a real Inbox with config.json deciding:
 *
 *  - off and no preview: the read and a Checklist save's `event: capabilities` carry Code review off and leave Shape out;
 *  - already on: both are there; turning one off answers `{ on: false }` and tells every window, then the next read
 *    still carries Code review (off) and leaves Shape out;
 *  - PLANNOTATOR_INBOX_PREVIEW=1: Shape is there while off, in the read and the event;
 *  - a release build: Code review's switch is there and off, Shape's is absent, and Code review's one-time offer is
 *    never next (`CODE_REVIEW_OFFER_SHOWN`: the owner chose the switch without the offer).
 *
 * What regresses: a person on a release build not finding Code review's switch, or seeing Shape's, or being shown the
 * offer; the owner (on) losing a row; a shown switch that cannot be turned off. Delete Shape's cases with `heldSwitch`.
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

type Frame = { board?: { on: boolean }; steps?: { on: boolean }; bro?: { on: boolean }; code_review?: { on: boolean }; shape?: { on: boolean }; reveal?: { next: string | null } };

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

test("off, no preview: the settings read and a Checklist save's event carry Code review off and leave Shape out", async () => {
  for (const config of [null, { inboxCodeReview: false, inboxShape: false }]) {
    const w = await world(config, false);
    const read = await w.read();
    expect(read.steps).toEqual({ on: false });
    expect(read.code_review).toEqual({ on: false });
    expect("shape" in read).toBe(false);

    const stream = await windowCapabilities(w.base);
    const saved = await w.save({ steps: { on: true } });
    expect(saved.code_review).toEqual({ on: false });
    expect("shape" in saved).toBe(false);
    await stream.next(1);
    expect(stream.frames).toEqual([{ board: { on: false }, steps: { on: true }, bro: { on: false }, code_review: { on: false } }]);
    await stream.stop();
  }
});

test("already on: both rows' keys are there; turning each off answers off and tells the windows; then Code review stays (off) and Shape goes", async () => {
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
  expect(stream.frames[1]).toEqual({ board: { on: false }, steps: { on: false }, bro: { on: false }, code_review: { on: false }, shape: { on: false } });
  await stream.stop();

  const after = await w.read();
  expect(after.code_review).toEqual({ on: false });
  expect("shape" in after).toBe(false);
});

test("PLANNOTATOR_INBOX_PREVIEW=1: Shape is there while off, in the read and in the windows' event", async () => {
  const w = await world(null, true);
  const read = await w.read();
  expect(read.code_review).toEqual({ on: false });
  expect(read.shape).toEqual({ on: false });

  const stream = await windowCapabilities(w.base);
  await w.save({ steps: { on: true } });
  await stream.next(1);
  expect(stream.frames).toEqual([{ board: { on: false }, steps: { on: true }, bro: { on: false }, code_review: { on: false }, shape: { on: false } }]);
  await stream.stop();
});

test("a release build: the Code review switch is there and off, the Shape switch is absent, and Code review's offer is never next", async () => {
  for (const version of ["0.28.50", "0.30.0"]) {
    const off = await (await world({ updateCheck: false }, false, version)).read();
    expect(off.code_review).toEqual({ on: false });
    expect("shape" in off).toBe(false);
    expect(off.reveal).toBeDefined();
    expect(off.reveal!.next).not.toBe("code_review");

    const on = await (await world({ updateCheck: false, inboxCodeReview: true, inboxShape: true }, false, version)).read();
    expect(on.code_review).toEqual({ on: true });
    expect(on.shape).toEqual({ on: true });

    const preview = await (await world({ updateCheck: false }, true, version)).read();
    expect(preview.code_review).toEqual({ on: false });
    expect(preview.shape).toEqual({ on: false });
    expect(preview.reveal).toBeDefined();
    expect(preview.reveal!.next).not.toBe("code_review");
  }
});
