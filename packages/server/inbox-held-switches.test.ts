/**
 * Code review was held back from 0.28.49 (owner decision, 2026-11-04). On 2026-11-17 the owner let Code review's
 * Settings → Capabilities switch show to everyone ("keep code review, no need for the code review dialogue, but enable
 * it in the capabilities"). Shape is gone: no settings read, save or window event carries a `shape` key, whatever
 * config.json's old `inboxShape` says. Settings draws a row only for a key the settings read carries, so the proof is
 * on the doors a window reads, on a real Inbox with config.json deciding:
 *
 *  - off: the read and a Checklist save's `event: capabilities` carry Code review off and no Shape;
 *  - on (with an old `inboxShape: true`): turning Code review off answers `{ on: false }` and tells every window, then
 *    the next read still carries Code review (off); a save of `shape` alone is not a setting;
 *  - a release build: Code review's switch is there and off. Code review's one-time offer, while shown
 *    (`CODE_REVIEW_OFFER_SHOWN`; the `codeReviewOffer` test option shows it whichever way the release has it), is next
 *    for someone who used an earlier Inbox while Code review was never decided, never once it is on, never for a fresh
 *    install; switched off (as from 0.29.6), it is never next, and the switch is there all the same.
 *
 * What regresses: a person on a release build not finding Code review's switch, or being shown the offer with Code
 * review on, or as a fresh install, or at all while it is switched off; the owner
 * (on) losing the row; a shown switch that cannot be turned off; an old `inboxShape` bringing a Shape row back.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

type Frame = { board?: { on: boolean }; steps?: { on: boolean }; bro?: { on: boolean }; code_review?: { on: boolean }; shape?: { on: boolean }; reveal?: { next: string | null } };

async function world(config: Record<string, unknown> | null, version?: string, codeReviewOffer?: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-held-switches-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false, ...(version ? { version, binaryPath: null } : {}), ...(codeReviewOffer === undefined ? {} : { codeReviewOffer }) });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const read = async () => (await (await fetch(`${base}/api/inbox/settings`)).json()) as Frame;
  const post = (body: Record<string, unknown>) =>
    fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const save = async (body: Record<string, unknown>) => {
    const response = await post(body);
    expect(response.status).toBe(200);
    return (await response.json()) as Frame;
  };
  return { base, read, save, post };
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

test("off: the settings read and a Checklist save's event carry Code review off and no Shape", async () => {
  for (const config of [null, { inboxCodeReview: false, inboxShape: false }, { inboxShape: true }]) {
    const w = await world(config);
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

test("on, with an old inboxShape: true: Code review's row is there and turns off, telling the windows; Shape is never there", async () => {
  const w = await world({ inboxCodeReview: true, inboxShape: true });
  const read = await w.read();
  expect(read.code_review).toEqual({ on: true });
  expect("shape" in read).toBe(false);

  const stream = await windowCapabilities(w.base);
  const saved = await w.save({ code_review: { on: false } });
  expect(saved.code_review).toEqual({ on: false });
  expect("shape" in saved).toBe(false);
  await stream.next(1);
  expect(stream.frames).toEqual([{ board: { on: false }, steps: { on: false }, bro: { on: false }, code_review: { on: false } }]);
  await stream.stop();

  // `shape` is not a setting: alone it saves nothing, beside a setting it is ignored.
  const alone = await w.post({ shape: { on: true } });
  expect(alone.ok).toBe(false);
  const beside = await w.save({ steps: { on: true }, shape: { on: true } });
  expect("shape" in beside).toBe(false);

  const after = await w.read();
  expect(after.code_review).toEqual({ on: false });
  expect("shape" in after).toBe(false);
});

test("a release build: the Code review switch is there and off, no Shape switch, and Code review's offer (while shown) is next only for someone who used an earlier Inbox while Code review was never decided", async () => {
  // Someone who used an earlier Inbox (a setting its page wrote, inbox.ts `inboxUsedBefore`): the offer is theirs.
  const earlier = { updateCheck: false, inboxNotifications: { dismissed: true } };
  for (const version of ["0.28.50", "0.30.0"]) {
    const off = await (await world(earlier, version, true)).read();
    expect(off.code_review).toEqual({ on: false });
    expect("shape" in off).toBe(false);
    expect(off.reveal).toBeDefined();
    expect(off.reveal!.next).toBe("code_review");

    // A fresh install: the switch is there, the offer never is.
    const fresh = await (await world({ updateCheck: false }, version, true)).read();
    expect(fresh.code_review).toEqual({ on: false });
    expect(fresh.reveal!.next).not.toBe("code_review");

    const on = await (await world({ ...earlier, inboxCodeReview: true, inboxShape: true }, version, true)).read();
    expect(on.code_review).toEqual({ on: true });
    expect("shape" in on).toBe(false);
    expect(on.reveal!.next).not.toBe("code_review");
  }
});

test("a release build with Code review's offer switched off (as from 0.29.6): the switch is there and off and can be turned on; the offer is never next", async () => {
  const earlier = { updateCheck: false, inboxNotifications: { dismissed: true } };
  for (const version of ["0.28.50", "0.30.0"]) {
    const w = await world(earlier, version, false);
    const read = await w.read();
    expect(read.code_review).toEqual({ on: false });
    expect(read.reveal).toBeDefined();
    expect(read.reveal!.next).not.toBe("code_review");
    expect((await w.save({ code_review: { on: true } })).code_review).toEqual({ on: true });
    expect((await w.read()).code_review).toEqual({ on: true });
  }
});
