/**
 * A linked computer's canvas through this Inbox's real forward and outbox (inbox-machines.ts), to a stand-in far door
 * on loopback that can go away (PLANNOTATOR_TEST_SANDBOX lets the transport take it). No Inbox runs.
 *
 * What regresses: a save too large for the outbox refused (422) even while that computer is online, or held anyway
 * while it is away; each delivered canvas save costing a read of that computer's whole list; a drawing job from that
 * computer that no window here can draw (none open, or the canvas off here) left for its agent to wait out.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxMachines, type MachineFrame } from "./inbox-machines";
import { InboxLinks } from "./inbox-links";
import { OUTBOX_MAX_BODY_BYTES } from "./inbox-outbox";

const FAR = "ibx_01K00000000000000000000000";
const TOKEN = "tok_test";
const SESSION = "srv";
const THREAD = "msg_01K00000000000000000000001";
const JOB = `job_${"ab".repeat(16)}`;

let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-canvas-forward-")));
  savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
  rmSync(root, { recursive: true, force: true });
});

/** MacBook's door: its canvas routes answer as its window's would; `say` sends a frame on its stream; `away()` drops it. */
function macbookDoor() {
  const state = { down: false, lists: 0, asks: [] as string[], writes: [] as { route: string; search: string; type: string | null; bytes: number }[] };
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const route = url.pathname.replace("/api/inbox/device/", "");
      if (state.down) return new Response("away", { status: 503 });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ code: "device_token_invalid" }, { status: 401 });
      if (route === "health") return Response.json({ ok: true, inbox_id: FAR, machine_links: 1, version: "0.29.9" });
      if (route === "threads") {
        state.lists++;
        return Response.json({ cursor: 1, sections: [], projects: [], marks: ["canvas"] });
      }
      if (route === "events") {
        state.asks.push(url.search);
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            streams.add(c);
            c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":1}\n\n`));
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (req.method === "POST") {
        const bytes = (await req.arrayBuffer()).byteLength;
        state.writes.push({ route, search: url.search, type: req.headers.get("content-type"), bytes });
        if (route.startsWith("canvas/jobs/")) return Response.json({ ok: true });
        return Response.json({ serverSession: "far", rev: state.writes.length });
      }
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    say(event: string, data: unknown) {
      for (const c of streams) c.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    away() {
      state.down = true;
      for (const c of streams) c.close();
      streams.clear();
    },
  };
}

function inbox(url: string, canvasOn = true) {
  const dataDir = join(root, "data");
  InboxLinks.open(dataDir).put({ id: FAR, name: "MacBook", token: TOKEN, transport: { kind: "tailnet", url }, device_id: null, linked_at: "2026-11-01T00:00:00Z" });
  const noop = () => {};
  const machines = createInboxMachines({
    dataDir,
    serverSession: SESSION,
    computerName: () => "Studio",
    door: {
      openMachineOffer: () => ({ secret: "s", code: "000000", expires_at: "" }),
      offerDevice: () => null,
      closeMachineOffer: () => null,
      openIntroductionOffer: () => ({ secret: "s", expires_at: "" }),
      introduction: () => null,
      settleIntroduction: noop,
      dropIntroductions: noop,
      revokeDevice: noop,
      tailnetAddress: () => null,
      tailnetError: () => null,
      publishTailnet: () => ({ ok: false, message: "no" }),
      closeTailnetIfUnused: noop,
    },
    readBody: async (req) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    holds: () => false,
    ownVersions: () => ({ current: "0.29.9", latest: null }),
    canvasOn: () => canvasOn,
    timings: { silenceMs: 60_000, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 1000, sendMs: 1000 },
  });
  cleanups.push(() => machines.stop());
  machines.start();
  const call = async (path: string, body: Record<string, unknown>) => {
    const target = new URL(`http://127.0.0.1:1${path}`);
    const headers = { Host: "127.0.0.1:1", Origin: "http://127.0.0.1:1", "Content-Type": "application/json" };
    const answer = (await machines.route(new Request(target, { method: "POST", headers, body: JSON.stringify({ serverSession: SESSION, ...body }) }), target, "local"))!;
    return { status: answer.status, body: (await answer.json().catch(() => null)) as Record<string, any> };
  };
  const macbook = () => machines.machinesView().find((m) => m.id === FAR);
  const waiting = async () => {
    const target = new URL("http://127.0.0.1:1/api/inbox/outbox");
    const answer = (await machines.route(new Request(target, { headers: { Host: "127.0.0.1:1" } }), target, "local"))!;
    return ((await answer.json()) as { waiting: unknown[] }).waiting.length;
  };
  return { machines, call, macbook, waiting };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(20);
  if (!check()) throw new Error(`never: ${what}`);
}

const scene = (elements: unknown[]) => ({ type: "excalidraw", version: 2, source: "test", elements, appState: {}, files: {} });
/** One long stroke: a single thing past the outbox's bound. */
const longStroke = () => ({ id: "stroke_long", type: "freedraw", version: 1, versionNonce: 1, isDeleted: false, x: 0, y: 0, points: Array.from({ length: 12_000 }, (_, i) => [i * 1.123456789, i * 2.987654321]) });

test("a canvas save too large for the outbox goes at once while MacBook is online, and waits in the window (503, nothing held) while it is away", async () => {
  const door = macbookDoor();
  const { call, macbook, waiting } = inbox(door.url);
  await until(() => macbook()?.state === "online" && macbook()?.list_cursor === 1, "MacBook online");
  const big = { idempotency_key: "canvas-big-1", scene: scene([longStroke()]), have: 0, partial: true, window: "cw_test" };
  expect(JSON.stringify(big).length).toBeGreaterThan(OUTBOX_MAX_BODY_BYTES);
  const sent = await call(`/api/inbox/m/${FAR}/threads/${THREAD}/canvas`, big);
  expect([sent.status, sent.body?.rev]).toEqual([200, 1]);
  expect(door.state.writes.map((w) => w.route)).toEqual([`threads/${THREAD}/canvas`]);
  expect(await waiting()).toBe(0);

  door.away();
  await until(() => macbook()?.state !== "online", "MacBook away");
  const away = await call(`/api/inbox/m/${FAR}/threads/${THREAD}/canvas`, { ...big, idempotency_key: "canvas-big-2" });
  expect([away.status, away.body?.code]).toEqual([503, "machine_offline"]);
  expect(await waiting()).toBe(0);
});

test("a delivered canvas save and Undo read nothing of MacBook again: no list read for each save", async () => {
  const door = macbookDoor();
  const { call, macbook } = inbox(door.url);
  await until(() => macbook()?.state === "online" && macbook()?.list_cursor === 1, "MacBook online");
  const lists = door.state.lists;
  for (let i = 1; i <= 3; i++) {
    const saved = await call(`/api/inbox/m/${FAR}/threads/${THREAD}/canvas`, { idempotency_key: `canvas-${i}`, scene: scene([{ id: "box", type: "rectangle", version: i }]), have: i - 1, partial: true });
    expect(saved.status).toBe(200);
  }
  expect((await call(`/api/inbox/m/${FAR}/threads/${THREAD}/canvas/undo`, { idempotency_key: "undo-1", rev: 2 })).status).toBe(200);
  await Bun.sleep(100);
  expect(door.state.lists).toBe(lists);
});

test("a drawing job from MacBook that no window here can draw is answered at once; one a window here can draw reaches it", async () => {
  const door = macbookDoor();
  const { machines, macbook } = inbox(door.url);
  await until(() => macbook()?.state === "online" && door.state.asks.length > 0, "MacBook online");
  expect(new URLSearchParams(door.state.asks[0]).get("canvas")).toBe("1");
  // No window open here: its agent hears "no drawing" now, not after the job's whole wait.
  door.say("canvas-job", { id: JOB, kind: "picture", thread_id: THREAD });
  await until(() => door.state.writes.length === 1, "the job answered");
  expect(door.state.writes[0]!.route).toBe(`canvas/jobs/${JOB}`);
  expect(new URLSearchParams(door.state.writes[0]!.search).get("failed")).toBe("1");
  door.say("canvas-job", { id: JOB.replace("ab", "cd"), kind: "mermaid", texts: ["graph TD; A-->B"] });
  await until(() => door.state.writes.length === 2, "the mermaid job answered");
  expect(door.state.writes[1]!.type).toBe("application/json");
  // A window open here draws it: the job reaches the window, and nothing is answered for it.
  const heard: MachineFrame[] = [];
  const stop = machines.subscribe((frame) => void heard.push(frame));
  door.say("canvas-job", { id: JOB.replace("ab", "ef"), kind: "picture", thread_id: THREAD });
  await until(() => heard.some((f) => f.event === "canvas-job"), "the job at the window");
  await Bun.sleep(100);
  expect(door.state.writes.length).toBe(2);
  stop();
});

test("the canvas off here: MacBook's stream asks for no canvas frames, and a job that comes anyway is answered at once", async () => {
  const door = macbookDoor();
  const { machines, macbook } = inbox(door.url, false);
  await until(() => macbook()?.state === "online" && door.state.asks.length > 0, "MacBook online");
  expect(new URLSearchParams(door.state.asks[0]).has("canvas")).toBe(false);
  const heard: MachineFrame[] = [];
  const stop = machines.subscribe((frame) => void heard.push(frame));
  door.say("canvas-job", { id: JOB, kind: "picture", thread_id: THREAD });
  await until(() => door.state.writes.length === 1, "the job answered");
  expect(heard.some((f) => f.event === "canvas-job")).toBe(false);
  stop();
});
