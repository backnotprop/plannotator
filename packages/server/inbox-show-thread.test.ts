/**
 * `plannotator inbox --open <thread>` (issue #2506): `POST
 * /api/inbox/control/show` moves the Inbox window open on this computer to a
 * thread. The server picks the window the person used last (its report says
 * `used` when it gets focus; a window on another device, over the tailnet, is
 * never picked) and sends `event: show` naming that window on the windows'
 * event streams. With no window open it answers `shown: false`, and the CLI
 * opens one at the thread. Temp data dir, loopback only.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxWindows } from "./inbox-windows";

const roots: string[] = [];
const servers: InboxServer[] = [];
const streams: AbortController[] = [];

afterEach(() => {
  for (const controller of streams.splice(0)) controller.abort();
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agent: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_show", name: null };

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-show-")));
  roots.push(root);
  mkdirSync(join(root, "web"), { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, htmlContent: "<!doctype html><title>Inbox</title>" });
  servers.push(server);
  const project = server.store.ensureProject({ name: "web", root: join(root, "web") });
  const a = server.store.sendMessage({ project_id: project.id, author: agent, body: "First.", subject: "Thread A" }).message;
  const b = server.store.sendMessage({ project_id: project.id, author: agent, body: "Second.", subject: "Thread B" }).message;
  const bReply = server.store.sendMessage({ project_id: project.id, author: agent, body: "More.", reply_to: b.id }).message;
  return { server, a, b, bReply };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

const show = (server: InboxServer, thread: unknown, token: string | null = server.token) =>
  fetch(`${base(server)}/api/inbox/control/show`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify({ thread }),
  });

const report = (server: InboxServer, window: string, used: boolean) =>
  fetch(`${base(server)}/api/inbox/window`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ window, permission: "default", origin: "http://localhost:1", used }),
  });

/** A window's event stream, with the `show` frames it heard. */
function openWindow(server: InboxServer, id: string): { shows: { thread_id: string; window: string }[]; ready: Promise<void> } {
  const controller = new AbortController();
  streams.push(controller);
  const shows: { thread_id: string; window: string }[] = [];
  let ready!: () => void;
  const readyP = new Promise<void>((resolve) => (ready = resolve));
  void fetch(`${base(server)}/api/inbox/events?cursor=0&window=${id}&permission=default&origin=${encodeURIComponent("http://localhost:1")}`, { signal: controller.signal })
    .then(async (res) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
        if (text.includes("event: hello")) ready();
        let end: number;
        while ((end = text.indexOf("\n\n")) !== -1) {
          const frame = text.slice(0, end);
          text = text.slice(end + 2);
          const match = /^event: show\ndata: (.*)$/m.exec(frame);
          if (match) shows.push(JSON.parse(match[1]!));
        }
      }
    })
    .catch(() => {});
  return { shows, ready: readyP };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

test("lastUsed: the window on this computer that reported `used` last; never a tailnet window; null with none open", () => {
  let clock = 1_000;
  const windows = createInboxWindows({ now: () => clock });
  expect(windows.lastUsed()).toBeNull();
  const leaveA = windows.connect("w-window-a01", { permission: "default", origin: null, via: "local" });
  const leaveB = windows.connect("w-window-b01", { permission: "default", origin: null, via: "local" });
  // Neither said it was used: the one opened later.
  expect(windows.lastUsed()).toBe("w-window-b01");
  clock += 10;
  windows.report("w-window-a01", { permission: "default", origin: null, via: "local", used: true });
  expect(windows.lastUsed()).toBe("w-window-a01");
  // A report without focus changes nothing.
  clock += 10;
  windows.report("w-window-b01", { permission: "default", origin: null, via: "local", used: false });
  expect(windows.lastUsed()).toBe("w-window-a01");
  // A tab of the same browser (a follower) that gets focus is picked too.
  clock += 10;
  windows.report("w-follow-c01", { permission: "default", origin: null, via: "local", servedBy: "w-window-a01", used: true });
  expect(windows.lastUsed()).toBe("w-follow-c01");
  // A window on another device, used later still, is never moved from this computer.
  clock += 10;
  const leaveT = windows.connect("w-tailnet-01", { permission: "default", origin: null, via: "tailnet" });
  windows.report("w-tailnet-01", { permission: "default", origin: null, via: "tailnet", used: true });
  expect(windows.lastUsed()).toBe("w-follow-c01");
  // A closed tab is not picked.
  windows.leave("w-follow-c01");
  expect(windows.lastUsed()).toBe("w-window-a01");
  leaveA();
  leaveB();
  windows.leave("w-window-a01");
  windows.leave("w-window-b01");
  expect(windows.lastUsed()).toBeNull();
  leaveT();
  windows.stop();
});

test("the window used last hears `show` with the thread; a message id names its thread; the answer says it was shown", async () => {
  const { server, b, bReply } = await setup();
  const one = openWindow(server, "w-window-one1");
  const two = openWindow(server, "w-window-two1");
  await Promise.all([one.ready, two.ready]);
  expect((await report(server, "w-window-one1", true)).status).toBe(200);

  const answer = await show(server, bReply.id);
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ shown: true, thread: b.thread_id });
  // Every window's stream carries it (tabs share one stream); it names the window that moves.
  await until(() => one.shows.length === 1 && two.shows.length === 1);
  expect(one.shows[0]).toEqual({ thread_id: b.thread_id, window: "w-window-one1" });
  expect(two.shows[0]).toEqual({ thread_id: b.thread_id, window: "w-window-one1" });

  // The person moves to the other window: that one moves next.
  await report(server, "w-window-two1", true);
  await show(server, b.thread_id);
  await until(() => one.shows.length === 2);
  expect(one.shows[1]).toEqual({ thread_id: b.thread_id, window: "w-window-two1" });
});

test("an unknown thread answers 404 thread_unknown and moves no window", async () => {
  const { server } = await setup();
  const one = openWindow(server, "w-window-one1");
  await one.ready;
  for (const thread of ["msg_nothere", "", 42]) {
    const answer = await show(server, thread);
    expect(answer.status).toBe(404);
    expect(((await answer.json()) as { code: string }).code).toBe("thread_unknown");
  }
  await Bun.sleep(50);
  expect(one.shows).toEqual([]);
});

test("with no window open the answer is shown: false, so the caller opens one at the thread", async () => {
  const { server, a } = await setup();
  const answer = await show(server, a.id);
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ shown: false, thread: a.thread_id });
});

test("the route is a connection route: the Inbox token, POST only", async () => {
  const { server, a } = await setup();
  expect((await show(server, a.id, null)).status).toBe(401);
  expect((await show(server, a.id, "wrong")).status).toBe(401);
  const get = await fetch(`${base(server)}/api/inbox/control/show`, { headers: { Authorization: `Bearer ${server.token}` } });
  expect(get.status).toBe(405);
});
