/**
 * Notifications that never fail silently, the server's half:
 * - one origin: a browser navigation to 127.0.0.1:<port> (or [::1]) goes to
 *   http://localhost:<port>/, the address the Inbox opens and advertises,
 *   because notification permission is per origin. Nothing else redirects:
 *   APIs, the device door, MCP, the tailnet, a client without fetch metadata,
 *   another name (the fixed-address prototype's inbox.plannotator.localhost);
 * - which windows are open and whether any may notify (`notify_reach` on
 *   health, settings and the event stream's `reach` frames);
 * - an EventSource reconnect resumes from its Last-Event-ID, so a tab that
 *   slept catches up from where it was.
 * A running Inbox on loopback under a temp data dir; raw HTTP so the Host and
 * fetch-metadata headers are exactly what a browser would send.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxNotifyReach } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer, type InboxServerOptions } from "./inbox";
import { inboxCanonicalRedirect } from "./inbox-canonical";
import { createInboxWindows } from "./inbox-windows";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function inbox(options: Partial<InboxServerOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-notify-origin-")));
  roots.push(root);
  const server = await startInboxServer({ dataDir: join(root, "data"), htmlContent: "<!doctype html><title>Inbox</title>", ...options });
  servers.push(server);
  return { server, root };
}

const NAVIGATE = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "none" };

function raw(port: number, path: string, headers: Record<string, string>, method = "GET", body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", fail);
    if (body) req.write(body);
    req.end();
  });
}

test("a browser at 127.0.0.1 or [::1] goes to localhost with its query; the fragment stays with the browser", async () => {
  const { server } = await inbox();
  const port = server.port;
  expect(server.url).toBe(`http://localhost:${port}/`);
  for (const host of [`127.0.0.1:${port}`, `127.0.0.2:${port}`, `[::1]:${port}`]) {
    const answer = await raw(port, "/?from=agent", { Host: host, ...NAVIGATE });
    expect(answer.status).toBe(307);
    expect(answer.headers.location).toBe(`http://localhost:${port}/?from=agent`);
    expect(answer.headers["cache-control"]).toBe("no-store");
  }
  const canonical = await raw(port, "/", { Host: `localhost:${port}`, ...NAVIGATE });
  expect(canonical.status).toBe(200);
  expect(canonical.text).toContain("<title>Inbox</title>");
});

test("nothing else redirects: no fetch metadata, a frame, APIs, the door, MCP, HEAD, another name", async () => {
  const { server } = await inbox();
  const port = server.port;
  const host = { Host: `127.0.0.1:${port}` };
  // curl and the tests' own fetches (no fetch metadata) get the page.
  expect((await raw(port, "/", host)).status).toBe(200);
  // Not a top-level document.
  expect((await raw(port, "/", { ...host, ...NAVIGATE, "Sec-Fetch-Dest": "iframe" })).status).toBe(200);
  expect((await raw(port, "/", { ...host, ...NAVIGATE, "Sec-Fetch-Mode": "cors" })).status).toBe(200);
  expect((await raw(port, "/", { ...host, ...NAVIGATE }, "HEAD")).status).toBe(200);
  // APIs answer where they were asked, navigation headers or not.
  const health = await raw(port, "/api/inbox/health", { ...host, ...NAVIGATE });
  expect(health.status).toBe(200);
  expect(JSON.parse(health.text).app).toBe("plannotator-inbox");
  const list = await raw(port, "/api/inbox/threads", { ...host, ...NAVIGATE });
  expect(list.status).toBe(200);
  // The device door (phones off: its unknown-route 404, never a redirect).
  expect((await raw(port, "/api/inbox/device/health", { ...host, ...NAVIGATE })).status).toBe(404);
  // MCP keeps its own refusal for a browser.
  expect((await raw(port, "/mcp", { ...host, ...NAVIGATE }, "POST", "{}")).status).not.toBe(307);
  // Another loopback name (the fixed-address prototype's) is not a spelling of this port.
  expect((await raw(port, "/", { Host: "inbox.plannotator.localhost", ...NAVIGATE })).status).toBe(200);
  // Another port's spelling is not this server's.
  expect((await raw(port, "/", { Host: `127.0.0.1:${port + 1}`, ...NAVIGATE })).status).toBe(200);
});

test("the tailnet listener is never redirected", () => {
  const req = new Request("http://127.0.0.1:5555/", { headers: { Host: "127.0.0.1:5555", ...NAVIGATE } });
  expect(inboxCanonicalRedirect(req, new URL(req.url), 5555, "tailnet")).toBeNull();
  expect(inboxCanonicalRedirect(req, new URL(req.url), 5555, "local")?.status).toBe(307);
});

/** Read an event stream until `until` matches, then stop. */
async function readStream(response: Response, until: (text: string) => boolean, controller: AbortController): Promise<string> {
  const reader = response.body!.getReader();
  let text = "";
  const deadline = Date.now() + 5000;
  while (!until(text) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text;
}

function reachFrames(text: string): InboxNotifyReach[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.includes("event: reach"))
    .map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as InboxNotifyReach);
}

async function health(server: InboxServer): Promise<InboxNotifyReach> {
  return ((await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).json()) as { notify_reach: InboxNotifyReach }).notify_reach;
}

test("windows report what they may do: open streams are counted, a report changes it live, a closed tab leaves after the grace", async () => {
  const { server } = await inbox({ windowGraceMs: 100 });
  const base = `http://127.0.0.1:${server.port}`;
  expect(await health(server)).toEqual({ enabled: true, windows: 0, allowed: 0, allowed_origins: [] });

  const controller = new AbortController();
  const stream = await fetch(`${base}/api/inbox/events?cursor=0&window=w-tab-one-000&permission=granted&origin=${encodeURIComponent("http://localhost:1234")}`, {
    signal: controller.signal,
  });
  const first = await readStream(stream, (text) => text.includes("event: reach"), controller);
  expect(reachFrames(first).at(-1)).toEqual({ enabled: true, windows: 1, allowed: 1, allowed_origins: ["http://localhost:1234"] });
  expect(await health(server)).toMatchObject({ windows: 1, allowed: 1 });

  // A second tab at the old spelling, without permission: open, not allowed.
  const other = new AbortController();
  const otherStream = await fetch(`${base}/api/inbox/events?cursor=0&window=w-tab-two-000&permission=default&origin=${encodeURIComponent("http://127.0.0.1:1234")}`, { signal: other.signal });
  await Bun.sleep(20);
  expect(await health(server)).toEqual({ enabled: true, windows: 2, allowed: 1, allowed_origins: ["http://localhost:1234"] });

  // The first tab's permission is revoked in site settings: it reports, and the count follows.
  const report = await fetch(`${base}/api/inbox/window`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, window: "w-tab-one-000", permission: "denied", origin: "http://localhost:1234" }),
  });
  expect(report.status).toBe(200);
  expect(((await report.json()) as { notify_reach: InboxNotifyReach }).notify_reach).toMatchObject({ windows: 2, allowed: 0 });

  // Notifications off in Settings: reach says so, whatever the windows.
  await fetch(`${base}/api/inbox/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, notifications: { enabled: false } }),
  });
  expect((await health(server)).enabled).toBe(false);

  // Both responses stay referenced until here: Bun 1.4 closes the connection
  // of a streamed response that is garbage-collected unread, and the tab
  // would leave early.
  controller.abort();
  other.abort();
  await Promise.all([stream, otherStream].map((res) => res.body?.cancel().catch(() => {})));
  await Bun.sleep(30);
  // Within the grace the records are kept but no longer open.
  expect((await health(server)).windows).toBe(0);
  await Bun.sleep(150);
  expect(await health(server)).toEqual({ enabled: false, windows: 0, allowed: 0, allowed_origins: [] });
});

test("a report is validated and stale-tab guarded", async () => {
  const { server } = await inbox();
  const post = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${server.port}/api/inbox/window`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await post({ window: "bad id!", permission: "granted" })).status).toBe(422);
  expect((await post({ window: "w-tab-one-000", permission: "yes" })).status).toBe(422);
  expect((await post({ serverSession: "someone-else", window: "w-tab-one-000", permission: "granted" })).status).toBe(409);
  expect((await post({ window: "w-tab-one-000", permission: "granted", origin: "javascript:alert(1)" })).status).toBe(200);
  // Another site's page cannot report.
  const cross = await fetch(`http://127.0.0.1:${server.port}/api/inbox/window`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: JSON.stringify({ window: "w-tab-one-000", permission: "granted" }),
  });
  expect(cross.status).toBe(403);
});

test("a reconnect resumes from Last-Event-ID, not the cursor its URL was opened with", async () => {
  const { server, root } = await inbox();
  const project = join(root, "billing-svc");
  mkdirSync(project, { recursive: true });
  const client = new Client({ name: "inbox-notify-origin-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (body: string) =>
    ((await client.callTool({ name: "send_message", arguments: { project_path: project, body, agent_session: "ses_A" } })) as { structuredContent: { message_id: string } })
      .structuredContent.message_id;
  const early = await send("Early news, already seen.");
  const seenUpTo = server.store.cursor();
  const missed = await send(":::question\nKeep the retry window?\n\n- [ ] Yes\n- [ ] No\n:::");

  const controller = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=0`, {
    headers: { "Last-Event-ID": String(seenUpTo) },
    signal: controller.signal,
  });
  const text = await readStream(stream, (t) => t.includes(missed) && t.includes('"kind":"question"'), controller);
  controller.abort();
  expect(text).toContain(missed);
  expect(text).not.toContain(`"id":"${early}"`);

  // An unusable Last-Event-ID (empty, not a number) falls back to the URL's cursor: neither a full replay nor none.
  for (const header of ["", "abc", "-1", "1.5"]) {
    const ctl = new AbortController();
    const again = await fetch(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=${seenUpTo}`, {
      headers: { "Last-Event-ID": header },
      signal: ctl.signal,
    });
    const got = await readStream(again, (t) => t.includes(missed) && t.includes('"kind":"question"'), ctl);
    ctl.abort();
    expect([header, got.includes(missed)]).toEqual([header, true]);
    expect([header, got.includes(`"id":"${early}"`)]).toEqual([header, false]);
  }
});

test("reach frames go to Inbox windows only, never to a stream without a window id (the phone's door, contract 7.9)", async () => {
  const { server } = await inbox();
  const base = `http://127.0.0.1:${server.port}`;
  const plain = new AbortController();
  const plainStream = await fetch(`${base}/api/inbox/events?cursor=0`, { signal: plain.signal });
  const plainReader = plainStream.body!.getReader();
  let plainText = "";
  const reading = (async () => {
    try {
      for (;;) {
        const { value, done } = await plainReader.read();
        if (done) break;
        plainText += new TextDecoder().decode(value);
      }
    } catch {
      // Aborted.
    }
  })();
  const windowCtl = new AbortController();
  const windowStream = await fetch(`${base}/api/inbox/events?cursor=0&window=w-tab-one-000&permission=granted`, { signal: windowCtl.signal });
  const windowText = await readStream(windowStream, (t) => t.includes("event: reach"), windowCtl);
  expect(windowText).toContain("event: reach");
  // A second window opening changes the counts: the window streams hear it, the plain one never does.
  const second = new AbortController();
  const secondStream = await fetch(`${base}/api/inbox/events?cursor=0&window=w-tab-two-000&permission=default`, { signal: second.signal });
  expect(await readStream(secondStream, (t) => t.includes("event: reach"), second)).toContain('"windows":2');
  await Bun.sleep(200);
  plain.abort();
  windowCtl.abort();
  second.abort();
  await reading;
  expect(plainText).toContain("event: hello");
  expect(plainText).not.toContain("event: reach");
});

test("a reconnect past the grace comes back with its URL's stale permission; the page's report on hello puts it right", async () => {
  const { server } = await inbox({ windowGraceMs: 50 });
  const base = `http://127.0.0.1:${server.port}`;
  const report = (permission: string) =>
    fetch(`${base}/api/inbox/window`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ window: "w-tab-one-000", permission, origin: "http://localhost:1" }),
    });
  // Opened before the person allowed notifications, allowed since.
  const url = `${base}/api/inbox/events?cursor=0&window=w-tab-one-000&permission=default&origin=${encodeURIComponent("http://localhost:1")}`;
  const first = new AbortController();
  await readStream(await fetch(url, { signal: first.signal }), (t) => t.includes("event: reach"), first);
  await report("granted");
  expect(await health(server)).toMatchObject({ windows: 1, allowed: 1 });
  first.abort();
  await Bun.sleep(120);
  // EventSource reconnects with the same URL, past the grace (or after a restart): the record is new and stale.
  const again = new AbortController();
  await readStream(await fetch(url, { signal: again.signal }), (t) => t.includes("event: reach"), again);
  expect(await health(server)).toMatchObject({ windows: 1, allowed: 0 });
  // What the page does on the stream's hello (notify.ts reportWindow): the count is right again.
  await report("granted");
  expect(await health(server)).toMatchObject({ windows: 1, allowed: 1 });
  again.abort();
});

test("createInboxWindows: a report that lands before its stream is kept; a reconnect keeps the reported permission", async () => {
  const windows = createInboxWindows({ graceMs: 1000 });
  windows.report("w-early-000", { permission: "granted", origin: "http://localhost:1", via: "local" });
  expect(windows.reach(true)).toMatchObject({ windows: 0, allowed: 0 });
  const leave = windows.connect("w-early-000", { permission: "default", origin: null, via: "local" });
  // The URL's older permission does not undo the report.
  expect(windows.reach(true)).toMatchObject({ windows: 1, allowed: 1 });
  leave();
  // EventSource reconnects with the URL it was opened with.
  const again = windows.connect("w-early-000", { permission: "default", origin: null, via: "local" });
  expect(windows.reach(true)).toMatchObject({ windows: 1, allowed: 1 });
  again();
  windows.stop();
});
