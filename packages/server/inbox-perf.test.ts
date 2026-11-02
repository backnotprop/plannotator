/**
 * The Inbox's server timings (inbox-perf.ts), which run only with the debug log on: then every `/api/inbox/` answer
 * says where its time went, a slow one reaches the debug log with its phases, and a stalled event loop is noticed.
 * Off, an answer carries no Server-Timing and a phase is not timed. The wrapper is tested around a plain handler,
 * the switch against a real Inbox server in a temp data dir.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_SLOW_REQUEST_MS, perfPhase, retainPerfPhases, runningLoopWatches, withServerTiming, watchLoopStalls, type SlowRequest } from "./inbox-perf";

const busy = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Synchronous work, as a store read is.
  }
};
const route = (pathname: string) => pathname.replace(/msg_[A-Z0-9]+/, "*");

describe("withServerTiming", () => {
  // As a server with the debug log on does: phases are timed while one is retained.
  let release: () => void = () => {};
  beforeAll(() => {
    release = retainPerfPhases();
  });
  afterAll(() => release());

  test("an /api/inbox/ answer carries Server-Timing: each phase (repeats summed) and app", async () => {
    const served = withServerTiming(
      async () => {
        perfPhase("rows", () => busy(3));
        perfPhase("rows", () => busy(3));
        return perfPhase("json", () => new Response("{}"));
      },
      route,
      null,
    );
    const header = (await served(new Request("http://127.0.0.1/api/inbox/threads"), "local")).headers.get("Server-Timing") ?? "";
    const dur = (name: string) => Number(new RegExp(`(?:^|, )${name};dur=([0-9.]+)`).exec(header)?.[1] ?? NaN);
    expect(dur("rows")).toBeGreaterThanOrEqual(6);
    expect(dur("json")).toBeGreaterThanOrEqual(0);
    expect(dur("app")).toBeGreaterThanOrEqual(dur("rows"));
    expect(header.match(/rows;/g)?.length).toBe(1);
  });

  test("the page and other routes get no header", async () => {
    const served = withServerTiming(async () => new Response("<html>"), route, null);
    expect((await served(new Request("http://127.0.0.1/"), "local")).headers.get("Server-Timing")).toBeNull();
  });

  test("a slow request is reported once with its route and phases; a fast one is not", async () => {
    const heard: SlowRequest[] = [];
    let wait = 0;
    const served = withServerTiming(
      async () => {
        perfPhase("thread", () => busy(wait));
        return new Response("{}");
      },
      route,
      (slow) => heard.push(slow),
    );
    await served(new Request("http://127.0.0.1/api/inbox/threads/msg_01ABC"), "local");
    expect(heard).toEqual([]);
    wait = INBOX_SLOW_REQUEST_MS + 20;
    await served(new Request("http://127.0.0.1/api/inbox/threads/msg_01ABC"), "local");
    expect(heard).toHaveLength(1);
    expect(heard[0]!.route).toBe("/api/inbox/threads/*");
    expect(heard[0]!.ms).toBeGreaterThanOrEqual(INBOX_SLOW_REQUEST_MS);
    expect(heard[0]!.phases.thread).toBeGreaterThanOrEqual(INBOX_SLOW_REQUEST_MS);
  });

  test("routes that wait or stream by design (bridge long-poll, events, forwards, uploads) write no slow line", async () => {
    const heard: SlowRequest[] = [];
    const served = withServerTiming(
      async () => {
        busy(INBOX_SLOW_REQUEST_MS + 10);
        return new Response("{}");
      },
      route,
      (slow) => heard.push(slow),
    );
    for (const path of ["/api/inbox/bridge/poll", "/api/inbox/events", "/api/inbox/m/mac-mini/threads", "/api/inbox/uploads"]) {
      const response = await served(new Request(`http://127.0.0.1${path}`), "local");
      expect(response.headers.get("Server-Timing")).toContain("app;dur=");
    }
    expect(heard).toEqual([]);
    await served(new Request("http://127.0.0.1/api/inbox/eventsx"), "local");
    expect(heard.map((slow) => slow.route)).toEqual(["/api/inbox/eventsx"]);
  });

  test("a log that throws never costs the answer", async () => {
    const served = withServerTiming(
      async () => {
        busy(INBOX_SLOW_REQUEST_MS + 10);
        return new Response("ok");
      },
      route,
      () => {
        throw new Error("disk full");
      },
    );
    const response = await served(new Request("http://127.0.0.1/api/inbox/drafts"), "local");
    expect(await response.text()).toBe("ok");
  });

  test("perfPhase outside a request just runs", () => {
    expect(perfPhase("rows", () => 7)).toBe(7);
  });
});

test("with no server timing (debug off), a phase inside a wrapped request is not timed", async () => {
  const served = withServerTiming(
    async () => {
      perfPhase("rows", () => busy(3));
      return new Response("{}");
    },
    route,
    null,
  );
  const header = (await served(new Request("http://127.0.0.1/api/inbox/threads"), "local")).headers.get("Server-Timing") ?? "";
  expect(header).not.toContain("rows");
});

describe("the debug switch, on a real Inbox", () => {
  const roots: string[] = [];
  const servers: InboxServer[] = [];
  const restore: (() => void)[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
    for (const undo of restore.splice(0)) undo();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const setEnv = (name: string, value: string | undefined) => {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    restore.push(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  };
  async function inbox(config: Record<string, unknown>): Promise<InboxServer> {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-perf-")));
    roots.push(dataDir);
    setEnv("PLANNOTATOR_DATA_DIR", dataDir);
    setEnv("PLANNOTATOR_INBOX_DEBUG", undefined);
    setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
    const server = await startInboxServer({ dataDir, binaryPath: null, phones: false });
    servers.push(server);
    return server;
  }
  const timing = async (server: InboxServer, path: string) => (await fetch(`http://127.0.0.1:${server.port}${path}`)).headers.get("Server-Timing");

  test("debug off: no Server-Timing on the list, a thread read or settings, no loop watch, no log", async () => {
    const server = await inbox({});
    expect(await timing(server, "/api/inbox/threads")).toBeNull();
    expect(await timing(server, "/api/inbox/settings")).toBeNull();
    expect(await timing(server, "/api/inbox/health")).toBeNull();
    expect(runningLoopWatches()).toBe(0);
    expect(existsSync(join(process.env.PLANNOTATOR_DATA_DIR!, "inbox", "debug.log"))).toBe(false);
  });

  test("debug on: the loop watch starts with the first logged request and ends with the Inbox", async () => {
    const server = await inbox({ inboxDebug: true });
    expect(runningLoopWatches()).toBe(0);
    await timing(server, "/api/inbox/threads");
    expect(runningLoopWatches()).toBe(1);
    server.stop();
    expect(runningLoopWatches()).toBe(0);
  });

  test("debug on (inboxDebug): the list's answer names its phases, and settings its disk walk", async () => {
    const server = await inbox({ inboxDebug: true });
    expect(await timing(server, "/")).toBeNull();
    const list = (await timing(server, "/api/inbox/threads")) ?? "";
    expect(list).toMatch(/(^|, )rows;dur=[0-9.]+/);
    expect(list).toMatch(/(^|, )json;dur=[0-9.]+/);
    expect(list).toMatch(/(^|, )app;dur=[0-9.]+$/);
    expect((await timing(server, "/api/inbox/settings")) ?? "").toMatch(/(^|, )disk;dur=/);
  });

  test("a debug-on Inbox stopped leaves no timing behind for a debug-off one", async () => {
    (await inbox({ inboxDebug: true })).stop();
    const off = await inbox({});
    expect(await timing(off, "/api/inbox/threads")).toBeNull();
    const served = withServerTiming(
      async () => {
        perfPhase("rows", () => busy(1));
        return new Response("{}");
      },
      route,
      null,
    );
    expect((await served(new Request("http://127.0.0.1/api/inbox/threads"), "local")).headers.get("Server-Timing") ?? "").not.toContain("rows");
  });
});

test("watchLoopStalls hears a blocked event loop, and stops", async () => {
  const stalls: number[] = [];
  const stop = watchLoopStalls((ms) => stalls.push(ms));
  await Bun.sleep(300);
  busy(450);
  await Bun.sleep(300);
  stop();
  expect(stalls.some((ms) => ms >= 100)).toBe(true);
  const seen = stalls.length;
  busy(450);
  await Bun.sleep(300);
  expect(stalls.length).toBe(seen);
});
