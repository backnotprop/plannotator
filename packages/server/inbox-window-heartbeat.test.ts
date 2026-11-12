import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_WINDOW_HEARTBEAT_MS, startInboxServer, type InboxServer } from "./inbox";
import { STREAM_STALE_MS } from "../inbox/liveStream";

const roots: string[] = [];
const servers: InboxServer[] = [];
const aborts: AbortController[] = [];

afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function inbox(windowHeartbeatMs: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-heartbeat-")));
  roots.push(root);
  const server = await startInboxServer({ dataDir: join(root, "data"), htmlContent: "<!doctype html><title>Inbox</title>", windowHeartbeatMs });
  servers.push(server);
  return server;
}

async function readFor(server: InboxServer, query: string, ms: number): Promise<string> {
  const abort = new AbortController();
  aborts.push(abort);
  const res = await fetch(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=${server.store.cursor()}${query}`, { signal: abort.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((done) => setTimeout(() => done(null), Math.max(1, deadline - Date.now())))]);
    if (chunk?.value) text += decoder.decode(chunk.value, { stream: true });
    if (chunk?.done) break;
  }
  abort.abort();
  return text;
}

test("a window's stream hears `event: heartbeat` on its interval; a stream without a window does not", async () => {
  const server = await inbox(100);
  const windowText = await readFor(server, "&window=window-heartbeat-1&permission=granted", 550);
  const beats = windowText.split("event: heartbeat\ndata: {}\n\n").length - 1;
  expect(beats).toBeGreaterThanOrEqual(3);
  expect(beats).toBeLessThanOrEqual(6);
  expect(windowText).not.toContain(": ping");
  const doorText = await readFor(server, "", 550);
  expect(doorText).toContain("event: hello");
  expect(doorText).not.toContain("event: heartbeat");
});

test("the page's silence window holds at least two and a half heartbeats", () => {
  expect(STREAM_STALE_MS).toBeGreaterThanOrEqual(INBOX_WINDOW_HEARTBEAT_MS * 2.5);
});
