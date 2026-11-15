/**
 * The warning before a Mark read that sets questions aside (the owner's ask, 2026-11-10), its switch on a real Inbox
 * with config.json deciding:
 *
 *  - unset: on in the settings read (everyone has the warning until they say otherwise), and another switch's
 *    `event: capabilities` leaves it out (a window's frame stays as it was);
 *  - "Don't show this again" (off), then Settings (on again): config.json `inboxMarkReadWarning` is written, the answer
 *    and the read follow, and every window hears each change, so no other window asks again;
 *  - a bad value is refused and writes nothing.
 *
 * What regresses: the warning off for someone who never turned it off, a "Don't show this again" that is not kept
 * or that another window does not hear, or a switch Settings cannot turn back on.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

type Frame = { board?: { on: boolean }; steps?: { on: boolean }; bro?: { on: boolean }; mark_read_warning?: { on: boolean } };

async function world(config: Record<string, unknown> | null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-mark-read-warning-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
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
  const saved = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Record<string, unknown>;
  return { base, read, post, save, saved };
}

/** A window's event stream: the `event: capabilities` frames, as they arrive. */
async function windowCapabilities(base: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/inbox/events?window=mark-read-warning-test`, { signal: controller.signal, headers: { "Sec-Fetch-Site": "same-origin" } });
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

test("unset: on in the read, and another switch's event leaves it out", async () => {
  const w = await world(null);
  expect((await w.read()).mark_read_warning).toEqual({ on: true });
  const stream = await windowCapabilities(w.base);
  await w.save({ steps: { on: true } });
  await stream.next(1);
  expect("mark_read_warning" in stream.frames[0]!).toBe(false);
  await stream.stop();
});

test("turned off, then back on: config.json, the answer, the read and every window follow", async () => {
  const w = await world(null);
  const stream = await windowCapabilities(w.base);
  expect((await w.save({ mark_read_warning: { on: false } })).mark_read_warning).toEqual({ on: false });
  expect(w.saved().inboxMarkReadWarning).toBe(false);
  expect((await w.read()).mark_read_warning).toEqual({ on: false });
  await stream.next(1);
  expect(stream.frames[0]!.mark_read_warning).toEqual({ on: false });

  expect((await w.save({ mark_read_warning: { on: true } })).mark_read_warning).toEqual({ on: true });
  expect(w.saved().inboxMarkReadWarning).toBe(true);
  expect((await w.read()).mark_read_warning).toEqual({ on: true });
  await stream.next(2);
  expect(stream.frames[1]!.mark_read_warning).toEqual({ on: true });
  await stream.stop();
});

test("a bad value is refused and writes nothing", async () => {
  const w = await world({ inboxMarkReadWarning: false });
  for (const value of [{ on: "no" }, false, { on: true, extra: 1 }]) {
    expect((await w.post({ mark_read_warning: value })).status).toBe(422);
  }
  expect(w.saved().inboxMarkReadWarning).toBe(false);
  expect((await w.read()).mark_read_warning).toEqual({ on: false });
});
