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

  await Bun.sleep(250);
  expect(windows.reach(true)).toMatchObject({ windows: 3, allowed: 2 });

  windows.report("w-lonely-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-nobody-0001" });
  expect(windows.reach(true)).toMatchObject({ windows: 3 });

  windows.leave("w-follow-0002");
  expect(windows.reach(true)).toMatchObject({ windows: 2, allowed: 2 });

  leave();
  expect(windows.reach(true)).toMatchObject({ windows: 1, allowed: 1 });
  const leave2 = windows.connect("w-leader-0002", { permission: "granted", origin: "http://localhost:1", via: "local" });
  windows.report("w-follow-0001", { permission: "granted", origin: "http://localhost:1", via: "local", servedBy: "w-leader-0002" });
  await Bun.sleep(250);
  expect(windows.reach(true)).toMatchObject({ windows: 2, allowed: 2 });

  leave2();
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  await Bun.sleep(300);
  expect(windows.reach(true)).toMatchObject({ windows: 0, allowed: 0 });

  const leave3 = windows.connect("w-leader-0003", { permission: "granted", origin: null, via: "local" });
  windows.report("w-follow-0003", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0003" });
  windows.leave("w-follow-0003");
  expect(windows.reach(true)).toMatchObject({ windows: 1 });
  windows.report("w-follow-0003", { permission: "granted", origin: null, via: "local", servedBy: "w-leader-0003" });
  expect(windows.reach(true)).toMatchObject({ windows: 2 });
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
  windows.report("w-tab-a-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-tab-b-0001" });
  windows.report("w-tab-b-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-tab-a-0001" });
  expect(windows.reach(true)).toMatchObject({ windows: 0, allowed: 0 });
  clock += 10_000;
  await Bun.sleep(250);
  expect(windows.reach(true)).toMatchObject({ windows: 0 });

  const leaveC = windows.connect("w-tab-c-0001", { permission: "granted", origin: null, via: "local" });
  windows.report("w-tab-a-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-tab-c-0001" });
  windows.report("w-tab-b-0001", { permission: "granted", origin: null, via: "local", servedBy: "w-tab-a-0001" });
  expect(windows.reach(true)).toMatchObject({ windows: 2 });

  const leaveA = windows.connect("w-tab-a-0001", { permission: "granted", origin: null, via: "local" });
  expect(windows.reach(true)).toMatchObject({ windows: 3 });
  leaveA();
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
  expect(after).toBeGreaterThanOrEqual(110);
  expect(after).toBeLessThan(220);
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

  const gone = await report(server, { window: "w-follow-0001", gone: true });
  expect(gone.status).toBe(200);
  expect(((await gone.json()) as { notify_reach: InboxNotifyReach }).notify_reach).toMatchObject({ windows: 1 });
  expect((await report(server, { window: "bad id!", gone: true })).status).toBe(422);
  expect((await report(server, { window: "w-follow-0002", permission: "granted", served_by: "bad id!" })).status).toBe(422);
  expect((await report(server, { window: "w-follow-0002", permission: "granted", served_by: null })).status).toBe(200);

  const beacon = await fetch(`http://127.0.0.1:${server.port}/api/inbox/window`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${server.port}`, "Sec-Fetch-Site": "same-origin" },
    body: new Blob([JSON.stringify({ window: "w-leader-0001", gone: true })], { type: "application/json" }),
  });
  expect(beacon.status).toBe(200);
  expect((await healthOf(server)).notify_reach).toMatchObject({ windows: 0 });
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
  const after = await read(seqs[1]!);
  expect([...after.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual(seqs.slice(2));
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
  expect((await open({ Origin: "http://evil.localhost:1" })).status).toBe(403);
  expect((await open({ Origin: "null" })).status).toBe(403);
  for (const headers of [{ "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "none" }, {}, { Origin: base }]) {
    const res = await open(headers);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("event: hello");
  }
  expect((await healthOf(server)).event_streams).toBe(0);
});
