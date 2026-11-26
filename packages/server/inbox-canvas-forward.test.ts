/**
 * A linked computer's canvas through this Inbox's real forward and outbox (inbox-machines.ts), to a stand-in far door
 * on loopback that can go away (PLANNOTATOR_TEST_SANDBOX lets the transport take it). No Inbox runs.
 *
 * What regresses: a save too large for the outbox refused (422) even while that computer is online, or held anyway
 * while it is away; each delivered canvas save costing a read of that computer's whole list; a drawing job from that
 * computer that no window here can draw (none open, or the canvas off here) left for its agent to wait out; a save
 * folded, or a large one sent, ahead of a write of the same thread still waiting (a reply sent from the canvas, an Undo),
 * so it changes the canvas there before that write runs.
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
  const state = { down: false, lists: 0, asks: [] as string[], writes: [] as { route: string; search: string; type: string | null; bytes: number; body: any }[], busy: new Set<string>() };
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const slow: (() => void)[] = [];
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
        const raw = new Uint8Array(await req.arrayBuffer());
        const type = req.headers.get("content-type");
        const body = type?.startsWith("application/json") && raw.length > 0 ? JSON.parse(new TextDecoder().decode(raw)) : null;
        // A route it is slow to answer: the write is on its way (in the outbox, sent) until `release()`.
        if (state.busy.has(route)) await new Promise<void>((resolve) => slow.push(resolve));
        state.writes.push({ route, search: url.search, type, bytes: raw.byteLength, body });
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
    back() {
      state.down = false;
    },
    release() {
      state.busy.clear();
      for (const resolve of slow.splice(0)) resolve();
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
  const call = async (path: string, body: Record<string, unknown>, more: Record<string, string> = {}) => {
    const target = new URL(`http://127.0.0.1:1${path}`);
    const headers = { Host: "127.0.0.1:1", Origin: "http://127.0.0.1:1", "Content-Type": "application/json", ...more };
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

const box = (id: string, version: number) => ({ id, type: "rectangle", version, versionNonce: version, isDeleted: false });
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
  expect(new URLSearchParams(door.state.writes[0]!.search).get("none")).toBe("1");
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

test("canvas saves while MacBook is away wait as one entry, from any window; an Undo keeps its place; back, each goes once", async () => {
  const door = macbookDoor();
  const { call, macbook, waiting } = inbox(door.url);
  await until(() => macbook()?.state === "online" && macbook()?.list_cursor === 1, "MacBook online");
  door.away();
  await until(() => macbook()?.state !== "online", "MacBook away");
  const canvas = `/api/inbox/m/${FAR}/threads/${THREAD}/canvas`;
  const first = await call(canvas, { idempotency_key: "canvas-a", scene: scene([box("a", 1), box("b", 3)]), have: 3, partial: true, window: "cw_1" });
  expect(first.status).toBe(202);
  // Another window, or this one after a reload: b moved again (and an older copy of a), c drawn, one removed.
  const second = await call(canvas, { idempotency_key: "canvas-b", scene: scene([box("b", 4), box("c", 1)]), have: 4, partial: true, gone: ["old_1"], window: "cw_2" });
  const third = await call(canvas, { idempotency_key: "canvas-c", scene: scene([box("a", 0)]), have: 4, partial: true, window: "cw_2" });
  expect([second.status, third.status]).toEqual([202, 202]);
  expect([second.body.outbox.key, third.body.outbox.key]).toEqual(["canvas-a", "canvas-a"]);
  expect(await waiting()).toBe(1);
  // An Undo behind it: a later save is its own entry, after the Undo, so it lands after it there.
  expect((await call(`${canvas}/undo`, { idempotency_key: "undo-a", rev: 3 })).status).toBe(202);
  const later = await call(canvas, { idempotency_key: "canvas-d", scene: scene([box("d", 1)]), have: 4, partial: true });
  expect(later.body.outbox.key).toBe("canvas-d");
  expect(await waiting()).toBe(3);

  door.back();
  await until(() => door.state.writes.length === 3, "all three delivered");
  expect(door.state.writes.map((w) => w.route)).toEqual([`threads/${THREAD}/canvas`, `threads/${THREAD}/canvas/undo`, `threads/${THREAD}/canvas`]);
  const folded = door.state.writes[0]!.body;
  expect(folded.scene.elements.map((e: { id: string; version: number }) => `${e.id}@${e.version}`)).toEqual(["a@1", "b@4", "c@1"]);
  expect([folded.gone, folded.have, folded.partial, folded.idempotency_key]).toEqual([["old_1"], 3, true, "canvas-a"]);
  expect(door.state.writes[2]!.body.scene.elements.map((e: { id: string }) => e.id)).toEqual(["d"]);
  expect(await waiting()).toBe(0);
});

test("a save after a reply sent from the canvas while MacBook is away is not folded past the reply: three entries, in order", async () => {
  const door = macbookDoor();
  const { call, macbook, waiting } = inbox(door.url);
  await until(() => macbook()?.state === "online" && macbook()?.list_cursor === 1, "MacBook online");
  door.away();
  await until(() => macbook()?.state !== "online", "MacBook away");
  const canvas = `/api/inbox/m/${FAR}/threads/${THREAD}/canvas`;
  expect((await call(canvas, { idempotency_key: "canvas-a", scene: scene([box("a", 1)]), have: 1, partial: true })).status).toBe(202);
  // Send canvas: a reply to the thread's last message, named to the thread by the window.
  const sent = await call(`/api/inbox/m/${FAR}/messages/msg_01K00000000000000000000002/reply`, { idempotency_key: "reply-a", words: "see the drawing", seen_through_seq: 4 }, { "X-Plannotator-Thread": THREAD });
  expect(sent.status).toBe(202);
  const after = await call(canvas, { idempotency_key: "canvas-b", scene: scene([box("b", 1)]), have: 1, partial: true });
  expect(after.body.outbox.key).toBe("canvas-b");
  expect(await waiting()).toBe(3);

  door.back();
  await until(() => door.state.writes.length === 3, "all three delivered");
  expect(door.state.writes.map((w) => w.route)).toEqual([`threads/${THREAD}/canvas`, "messages/msg_01K00000000000000000000002/reply", `threads/${THREAD}/canvas`]);
  expect(door.state.writes.map((w) => w.body.scene?.elements.map((e: { id: string }) => e.id) ?? null)).toEqual([["a"], null, ["b"]]);
});

test("a save too large for the outbox waits (503) while a write of its thread is still on its way to MacBook, and goes after it", async () => {
  const door = macbookDoor();
  const { call, macbook, waiting } = inbox(door.url);
  await until(() => macbook()?.state === "online" && macbook()?.list_cursor === 1, "MacBook online");
  const canvas = `/api/inbox/m/${FAR}/threads/${THREAD}/canvas`;
  // An Undo MacBook is slow to answer: on its way, still in the outbox, while MacBook is online.
  door.state.busy.add(`threads/${THREAD}/canvas/undo`);
  const undo = call(`${canvas}/undo`, { idempotency_key: "undo-a", rev: 3 });
  for (let i = 0; i < 100 && (await waiting()) === 0; i++) await Bun.sleep(10);
  expect(await waiting()).toBe(1);
  const big = { idempotency_key: "canvas-big", scene: scene([longStroke()]), have: 3, partial: true };
  const early = await call(canvas, big);
  expect(early.status).toBe(503);
  expect(door.state.writes.map((w) => w.route)).toEqual([]);

  door.release();
  expect((await undo).status).toBe(200);
  await until(() => door.state.writes.length === 1, "the Undo delivered");
  for (let i = 0; i < 100 && (await waiting()) > 0; i++) await Bun.sleep(20);
  expect(await waiting()).toBe(0);
  const later = await call(canvas, { ...big, idempotency_key: "canvas-big-2" });
  expect(later.status).toBe(200);
  expect(door.state.writes.map((w) => w.route)).toEqual([`threads/${THREAD}/canvas/undo`, `threads/${THREAD}/canvas`]);
});
