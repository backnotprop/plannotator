/**
 * Thread panes' switch (config.json `inboxSplitView`; Settings → General → Appearance, off by default): the settings
 * read carries `split_view: { on }`, read from the file on every request, and POST /api/inbox/settings
 * `{ split_view: { on } }` writes the same key. What regresses: a window with the key absent (or not exactly `true`)
 * offered "Open to the side"; someone who turned it on in config.json before the Settings row losing it; a save not
 * reaching config.json, or taking a value that is not a boolean; the change not reaching every window's stream.
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

async function world(config: Record<string, unknown> | null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-split-view-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "config.json");
  const write = (next: Record<string, unknown>) => writeFileSync(file, JSON.stringify(next));
  if (config) write(config);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const read = async () => (await (await fetch(`${base}/api/inbox/settings`)).json()) as { split_view?: { on: boolean } };
  const save = (body: unknown) => fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const saved = () => (JSON.parse(readFileSync(file, "utf8")) as { inboxSplitView?: unknown }).inboxSplitView;
  return { base, read, write, save, saved };
}

test("off, absent or not exactly true: the settings read says off", async () => {
  for (const config of [null, { inboxSplitView: false }, { inboxSplitView: "true" }]) {
    const { read } = await world(config);
    expect((await read()).split_view).toEqual({ on: false });
  }
});

test("on in config.json: the settings read says so, and follows the file without a restart", async () => {
  const { read, write } = await world({ inboxSplitView: true });
  expect((await read()).split_view).toEqual({ on: true });
  write({ inboxSplitView: false });
  expect((await read()).split_view).toEqual({ on: false });
});

test("the Settings switch writes config.json's key, answers with it, and refuses anything but a boolean", async () => {
  const { read, save, saved } = await world({ inboxMarkReadWarning: false });
  const on = await save({ split_view: { on: true } });
  expect(on.status).toBe(200);
  expect(((await on.json()) as { split_view?: unknown }).split_view).toEqual({ on: true });
  expect(saved()).toBe(true);
  expect((await read()).split_view).toEqual({ on: true });
  const off = await save({ split_view: { on: false } });
  expect(((await off.json()) as { split_view?: unknown }).split_view).toEqual({ on: false });
  expect(saved()).toBe(false);
  for (const bad of [{ on: "yes" }, true, { on: true, extra: 1 }]) {
    expect((await save({ split_view: bad })).status).toBe(422);
  }
  expect(saved()).toBe(false);
});

/** A window's event stream: the `event: capabilities` frames, as they arrive (as inbox-mark-read-warning.test.ts reads them). */
async function windowCapabilities(base: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/inbox/events?window=split-view-test`, { signal: controller.signal, headers: { "Sec-Fetch-Site": "same-origin" } });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Record<string, unknown>[] = [];
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
        if (event === "capabilities") frames.push(JSON.parse(/^data: (.*)$/m.exec(block)![1]!) as Record<string, unknown>);
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
  return { frames, next: (count: number) => until(() => frames.length >= count), stop: async () => (controller.abort(), await pump) };
}

test("a change reaches every window's stream as `event: capabilities` naming split_view; another switch's frame leaves it out", async () => {
  const { base, save } = await world(null);
  const stream = await windowCapabilities(base);
  expect((await save({ split_view: { on: true } })).status).toBe(200);
  await stream.next(1);
  expect(stream.frames[0]!.split_view).toEqual({ on: true });
  expect((await save({ steps: { on: true } })).status).toBe(200);
  await stream.next(2);
  expect("split_view" in stream.frames[1]!).toBe(false);
  await stream.stop();
});
