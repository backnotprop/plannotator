/**
 * The second thread pane's preview switch (config.json `inboxSplitView`, no Settings row): the settings read carries
 * `split_view` only while it is `true`, read on every request. What regresses: a window with the switch off (or the
 * key absent, or not exactly `true`) getting the key and so offering "Open to the side"; the owner's test Inbox, switched
 * on in config.json, not getting it without a restart.
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

async function world(config: Record<string, unknown> | null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-split-view-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const write = (next: Record<string, unknown>) => writeFileSync(join(dataDir, "config.json"), JSON.stringify(next));
  if (config) write(config);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const read = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()) as { split_view?: { on: boolean } };
  return { read, write };
}

test("off, absent or not exactly true: the settings read has no split_view", async () => {
  for (const config of [null, { inboxSplitView: false }, { inboxSplitView: "true" }]) {
    const { read } = await world(config);
    expect("split_view" in (await read())).toBe(false);
  }
});

test("on in config.json: the settings read says so, and follows the file without a restart", async () => {
  const { read, write } = await world({ inboxSplitView: true });
  expect((await read()).split_view).toEqual({ on: true });
  write({ inboxSplitView: false });
  expect("split_view" in (await read())).toBe(false);
});
