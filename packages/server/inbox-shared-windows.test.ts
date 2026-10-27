/**
 * Tabs share one event stream (packages/inbox/sharedEvents.ts), the server's
 * half: a follower tab holds no stream, so it reports `served_by` (the leader
 * tab's window id) and counts for `notify_reach` while that leader is known;
 * a tab that closes reports `gone` and stops counting at once; health counts
 * the event streams open (`event_streams`), which the browser proofs read to
 * show one stream per origin.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxNotifyReach } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer, type InboxServerOptions } from "./inbox";
import { createInboxWindows } from "./inbox-windows";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  liveStreams.clear();
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function inbox(options: Partial<InboxServerOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-shared-windows-")));
  roots.push(root);
  const server = await startInboxServer({ dataDir: join(root, "data"), htmlContent: "<!doctype html><title>Inbox</title>", ...options });
  servers.push(server);
  return server;
}

async function healthOf(server: InboxServer): Promise<{ notify_reach: InboxNotifyReach; event_streams: number }> {
  return (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).json()) as { notify_reach: InboxNotifyReach; event_streams: number };
}

const report = (server: InboxServer, body: Record<string, unknown>) =>
  fetch(`http://127.0.0.1:${server.port}/api/inbox/window`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/**
 * Open event streams, held until their controller aborts: Bun 1.4 closes the
 * connection of a streamed response that is garbage-collected, and one read
 * on it does not keep it alive, so a GC mid-test would close the tab.
 */
const liveStreams = new Set<Response>();

function holdStream(url: string, controller: AbortController): void {
  void fetch(url, { signal: controller.signal })
    .then((res) => {
      liveStreams.add(res);
      controller.signal.addEventListener("abort", () => liveStreams.delete(res));
      return res.body?.getReader().read();
    })
    .catch(() => {});
}

function openStream(server: InboxServer, id: string, permission = "granted"): AbortController {
  const controller = new AbortController();
  holdStream(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=0&window=${id}&permission=${permission}&origin=${encodeURIComponent("http://localhost:1")}`, controller);
  return controller;
}

async function until(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

test("createInboxWindows: a follower counts while its leader is known, through a handover, and leaves at once when gone", async () => {
  const windows = createInboxWindows({ graceMs: 80 });
  const leave = windows.connect("w-leader-0001", { permission: "granted", origin: "http://localhost:1", via: "local" });
  windows.report("w-follow-0001", { permission: "granted", origin: "http://localhost:1", via: "local", servedBy: "w-leader-0001" });
  windows.report("w-follow-0002", { permission: "default", origin: "http://localhost:1", via: "local", servedBy: "w-leader-0001" });
  expect(windows.reach(true)).toEqual({ enabled: true, windows: 3, allowed: 2, allowed_origins: ["http://localhost:1"] });

  // Followers stay counted far past the grace while their leader holds its stream.
  await Bun.sleep(250);
  expect(windows.reach(true)).toMatchObject({ windows: 3, allowed: 2 });

  // A follower without a known leader is not counted (a report alone is not a window).
  windows.report("w-lonely-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-nobody-0001" });
  expect(windows.reach(true)).toMatchObject({ windows: 3 });

  // A follower that closes stops counting at once.
  windows.leave("w-follow-0002");
  expect(windows.reach(true)).toMatchObject({ windows: 2, allowed: 2 });

  // The leader closes: it stops counting at once, its follower stays through the grace (the handover)…
  leave();
  expect(windows.reach(true)).toMatchObject({ windows: 1, allowed: 1 });
  // …and moves to the new leader before the grace ends.
  const leave2 = windows.connect("w-leader-0002", { permission: "granted", origin: "http://localhost:1", via: "local" });
  windows.report("w-follow-0001", { permission: "granted", origin: "http://localhost:1", via: "local", servedBy: "w-leader-0002" });
  await Bun.sleep(250);
  expect(windows.reach(true)).toMatchObject({ windows: 2, allowed: 2 });

  // The whole browser goes: the last stream closes, and its followers go with the leader's grace.
  leave2();
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  await Bun.sleep(300);
  expect(windows.reach(true)).toMatchObject({ windows: 0, allowed: 0 });

  // A report after `gone` (a page back from the back/forward cache) counts it again.
  const leave3 = windows.connect("w-leader-0003", { permission: "granted", origin: null, via: "local" });
  windows.report("w-follow-0003", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0003" });
  windows.leave("w-follow-0003");
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  windows.report("w-follow-0003", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0003" });
  expect(windows.reach(true)).toMatchObject({ windows: 2 });
  // A tab cannot be served by itself.
  windows.report("w-leader-0003", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0003" });
  expect(windows.reach(true)).toMatchObject({ windows: 2 });
  leave3();
  windows.stop();
});

test("createInboxWindows: a leader that says gone before its stream closes stops counting; its followers keep counting through the grace", async () => {
  const windows = createInboxWindows({ graceMs: 80 });
  const leave = windows.connect("w-leader-0001", { permission: "granted", origin: null, via: "local" });
  windows.report("w-follow-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0001" });
  windows.leave("w-leader-0001");
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  leave();
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  await Bun.sleep(300);
  expect(windows.reach(true)).toMatchObject({ windows: 0 });
  windows.stop();
});

test("createInboxWindows: two tabs naming each other are never counted; followers count only through a leader's own stream", async () => {
  let clock = 1_000;
  const windows = createInboxWindows({ graceMs: 80, now: () => clock });
  // A and B each say the other serves them, and neither holds a stream: no window.
  windows.report("w-tab-a-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-tab-b-0001" });
  windows.report("w-tab-b-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-tab-a-0001" });
  expect(windows.reach(true)).toMatchObject({ windows: 0, allowed: 0 });
  // Long past the grace, still none (their records may linger; they never count).
  clock += 10_000;
  await Bun.sleep(250);
  expect(windows.reach(true)).toMatchObject({ windows: 0 });

  // C holds a stream and serves A; B is served by A (one link further): only C and A count.
  const leaveC = windows.connect("w-tab-c-0001", { permission: "granted", origin: null, via: "local" });
  windows.report("w-tab-a-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-tab-c-0001" });
  windows.report("w-tab-b-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-tab-a-0001" });
  expect(windows.reach(true)).toMatchObject({ windows: 2 });

  // A held a stream once: for one grace after it closed, its followers count; then not.
  const leaveA = windows.connect("w-tab-a-0001", { permission: "granted", origin: null, via: "local" });
  expect(windows.reach(true)).toMatchObject({ windows: 3 });
  leaveA();
  // A itself is served by C again (its report): A, B (through A's recent stream), C.
  windows.report("w-tab-a-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-tab-c-0001" });
  expect(windows.reach(true)).toMatchObject({ windows: 3 });
  clock += 81;
  expect(windows.reach(true)).toMatchObject({ windows: 2 });
  leaveC();
  windows.stop();
});

test("createInboxWindows: after the whole browser goes, its followers stop counting one grace after the leader's stream closed, and the pages hear it", async () => {
  const windows = createInboxWindows({ graceMs: 120 });
  const heard: number[] = [];
  windows.subscribe(() => heard.push(windows.reach(true).windows));
  const leave = windows.connect("w-leader-0001", { permission: "granted", origin: null, via: "local" });
  for (let i = 0; i < 4; i++) windows.report(`w-follow-000${i}`, { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0001" });
  expect(windows.reach(true)).toMatchObject({ windows: 5 });
  const closedAt = Date.now();
  leave();
  expect(windows.reach(true)).toMatchObject({ windows: 4 });
  while (windows.reach(true).windows > 0) await Bun.sleep(5);
  const after = Date.now() - closedAt;
  // One grace, never two (the old rule kept them through the leader's drop and then their own).
  expect(after).toBeGreaterThanOrEqual(110);
  expect(after).toBeLessThan(220);
  // The pages hear it when the expiry timer fires (one ms past the grace): wait for that, with a little slack.
  const heardBy = Date.now() + 100;
  while (heard.at(-1) !== 0 && Date.now() < heardBy) await Bun.sleep(5);
  expect(heard.at(-1)).toBe(0);
  windows.stop();
});

test("POST /api/inbox/window: served_by and gone are additive; health counts the event streams open", async () => {
  const server = await inbox({ windowGraceMs: 100 });
  expect((await healthOf(server)).event_streams).toBe(0);

  const leader = openStream(server, "w-leader-0001");
  await until(async () => (await healthOf(server)).event_streams === 1);
  // A stream without a window (the phone's door) counts too.
  const door = new AbortController();
  holdStream(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=0`, door);
  await until(async () => (await healthOf(server)).event_streams === 2);
  door.abort();
  await until(async () => (await healthOf(server)).event_streams === 1);

  const follower = await report(server, { window: "w-follow-0001", permission: "granted", origin: "http://localhost:1", served_by: "w-leader-0001" });
  expect(follower.status).toBe(200);
  expect(((await follower.json()) as { notify_reach: InboxNotifyReach }).notify_reach).toMatchObject({ windows: 2, allowed: 2 });
  await Bun.sleep(250);
  expect((await healthOf(server)).notify_reach).toMatchObject({ windows: 2 });

  // `gone` needs only the window (a beacon at pagehide), and is validated like a report.
  const gone = await report(server, { window: "w-follow-0001", gone: true });
  expect(gone.status).toBe(200);
  expect(((await gone.json()) as { notify_reach: InboxNotifyReach }).notify_reach).toMatchObject({ windows: 1 });
  expect((await report(server, { window: "bad id!", gone: true })).status).toBe(422);
  expect((await report(server, { window: "w-follow-0002", permission: "granted", served_by: "bad id!" })).status).toBe(422);
  // `served_by: null` is a tab with its own stream (no leader).
  expect((await report(server, { window: "w-follow-0002", permission: "granted", served_by: null })).status).toBe(200);

  // A beacon is a Blob with a JSON type, from the page's own origin: accepted.
  const beacon = await fetch(`http://127.0.0.1:${server.port}/api/inbox/window`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${server.port}`, "Sec-Fetch-Site": "same-origin" },
    body: new Blob([JSON.stringify({ window: "w-leader-0001", gone: true })], { type: "application/json" }),
  });
  expect(beacon.status).toBe(200);
  expect((await healthOf(server)).notify_reach).toMatchObject({ windows: 0 });
  // Another site cannot say a tab is gone.
  const cross = await fetch(`http://127.0.0.1:${server.port}/api/inbox/window`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: JSON.stringify({ window: "w-leader-0001", gone: true }),
  });
  expect(cross.status).toBe(403);

  leader.abort();
  await until(async () => (await healthOf(server)).event_streams === 0);
});

test("GET /api/inbox/events?once=1: the hello and the lines after the cursor, then the response ends; never counted as a stream", async () => {
  const server = await inbox();
  const project = join(roots.at(-1)!, "billing-svc");
  mkdirSync(project, { recursive: true });
  const client = new Client({ name: "inbox-shared-windows-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  try {
    for (let i = 0; i < 3; i++) {
      await client.callTool({ name: "send_message", arguments: { project_path: project, body: `Note ${i}`, agent_session: "ses_A" } });
    }
  } finally {
    await client.close();
  }
  const read = async (cursor: number) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=${cursor}&once=1`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    return res.text();
  };
  const all = await read(0);
  expect(all.startsWith("event: hello\n")).toBe(true);
  const seqs = [...all.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  expect(seqs.length).toBeGreaterThanOrEqual(3);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  // After a cursor: only the later lines.
  const after = await read(seqs[1]!);
  expect([...after.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual(seqs.slice(2));
  // The response ended (text() resolved) and no stream stayed open.
  expect((await healthOf(server)).event_streams).toBe(0);
});

test("GET /api/inbox/events refuses another site's page, and answers the Inbox's own page, the phone's door and agents", async () => {
  const server = await inbox();
  const base = `http://127.0.0.1:${server.port}`;
  const open = async (headers: Record<string, string>, query = "cursor=0&once=1") => fetch(`${base}/api/inbox/events?${query}`, { headers });
  for (const site of ["cross-site", "same-site"]) {
    const res = await open({ "Sec-Fetch-Site": site });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("cross_origin");
  }
  // An Origin naming another server, and `Origin: null` (a sandboxed page), are refused too.
  expect((await open({ Origin: "http://evil.localhost:1" })).status).toBe(403);
  expect((await open({ Origin: "null" })).status).toBe(403);
  // The window (same-origin fetch metadata), the phone's door and agents (no metadata) get the stream.
  for (const headers of [{ "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "none" }, {}, { Origin: base }]) {
    const res = await open(headers);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("event: hello");
  }
  // A refused stream was never counted.
  expect((await healthOf(server)).event_streams).toBe(0);
});
