/**
 * A linked computer's routines through this Inbox's real forward and outbox (inbox-machines.ts), to a stand-in far door
 * on loopback that can go away and come back (PLANNOTATOR_TEST_SANDBOX lets the transport take it). No Inbox runs.
 *
 * What regresses: a Run once now pressed while that computer is away held and run there hours later when it is back
 * (it is refused at the press, said in plain words, and never sent); a Stop that waited for it ending whatever run is
 * going when it lands (it names the run it was pressed for, also after this Inbox restarts); a held edit that looks
 * undone on the next read or a reload (the merged read lays it on the rows from the outbox until that computer takes it);
 * a turn off pressed while it is away lost, sent without the window's mark, or sent again on a later reconnect.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxMachines } from "./inbox-machines";
import { InboxLinks } from "./inbox-links";
import { ROUTINES_MARK } from "./inbox-scheduled-machines";
import { MACHINE_WINDOW_HEADER } from "./inbox-outbox";

const FAR = "ibx_01K00000000000000000000000";
const TOKEN = "tok_test";
const SESSION = "srv";

let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-routines-forward-")));
  savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
  rmSync(root, { recursive: true, force: true });
});

/** Studio's door: its list takes routines; `away()` drops its line and answers nothing until `back()`. */
function studioDoor(marks: string[] = [ROUTINES_MARK]) {
  /** `running`: a run of sch_1 is going there, so its row says "running" whether it is on or off (as rowOf does). */
  const state = { down: false, name: "Morning digest", enabled: true, running: false, writes: [] as { route: string; body: Record<string, unknown>; window: boolean }[] };
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
      if (route === "threads") return Response.json({ cursor: 1, sections: [], projects: [], marks });
      if (route === "events") {
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            streams.add(c);
            c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":1}\n\n`));
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (req.method === "GET" && route === "scheduled") {
        const row = { id: "sch_1", name: state.name, enabled: state.enabled, state: state.running ? "running" : state.enabled ? "on" : "off", updated_at: "2026-11-24T08:00:00.000Z" };
        return Response.json({ scheduled: [row], launch_on: true });
      }
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        state.writes.push({ route, body, window: req.headers.get(MACHINE_WINDOW_HEADER) === "1" });
        if (route === "scheduled/sch_1" && typeof body.name === "string") state.name = body.name;
        if (route === "scheduled/sch_1/on" || route === "scheduled/sch_1/off") state.enabled = route.endsWith("/on");
        // A run's answer, as Studio's window route gives it: 202, the run's divider.
        if (route === "scheduled/sch_1/run") return Response.json({ scheduled: { id: "sch_1", name: state.name, state: "running" }, message_id: "msg_run_1" }, { status: 202 });
        return Response.json({ scheduled: { id: "sch_1", name: state.name } });
      }
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    away() {
      state.down = true;
      for (const c of streams) c.close();
      streams.clear();
    },
    back() {
      state.down = false;
    },
  };
}

/** This Inbox's machines over a data dir (a restart is a second one over the same dir). */
function inbox(dataDir: string) {
  const noop = () => {};
  const machines = createInboxMachines({
    dataDir,
    serverSession: SESSION,
    computerName: () => "Laptop",
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
    timings: { silenceMs: 60_000, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 1000, sendMs: 1000 },
  });
  let stopped = false;
  const stop = () => {
    if (!stopped) machines.stop();
    stopped = true;
  };
  cleanups.push(stop);
  machines.start();
  const call = async (method: string, path: string, body?: Record<string, unknown>) => {
    const url = new URL(`http://127.0.0.1:1${path}`);
    const headers: Record<string, string> = { Host: "127.0.0.1:1", Origin: "http://127.0.0.1:1", "Content-Type": "application/json" };
    const answer = (await machines.route(new Request(url, { method, headers, body: body ? JSON.stringify({ serverSession: SESSION, ...body }) : undefined }), url, "local"))!;
    return { status: answer.status, body: (await answer.json().catch(() => null)) as Record<string, any> };
  };
  const studio = () => machines.machinesView().find((m) => m.id === FAR);
  return { machines, call, studio, stop };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(20);
  if (!check()) throw new Error(`never: ${what}`);
}

function linked(url: string) {
  const dataDir = join(root, "data");
  InboxLinks.open(dataDir).put({ id: FAR, name: "Studio", token: TOKEN, transport: { kind: "tailnet", url }, device_id: null, linked_at: "2026-11-01T00:00:00Z" });
  return dataDir;
}

test("Studio away: Run once now is refused at the press and never runs later; a held Stop names its run and lands after an Inbox restart", async () => {
  const door = studioDoor();
  door.away();
  const dataDir = linked(door.url);
  const first = inbox(dataDir);
  await Bun.sleep(100);
  expect(first.studio()?.state).not.toBe("online");

  const run = await first.call("POST", `/api/inbox/m/${FAR}/scheduled/sch_1/run`, { idempotency_key: "run-1" });
  expect([run.status, run.body.code]).toEqual([503, "machine_offline"]);
  const stop = await first.call("POST", `/api/inbox/m/${FAR}/scheduled/sch_1/stop`, { idempotency_key: "stop-1", run: "msg_run_0855" });
  expect(stop.status).toBe(202);
  const waiting = await first.call("GET", "/api/inbox/outbox");
  expect((waiting.body.waiting as { route: string }[]).map((w) => w.route)).toEqual(["scheduled/sch_1/stop"]);

  // This Inbox restarts; Studio is back: the held Stop goes, with the run it was pressed for. The Run never does.
  first.stop();
  door.back();
  const second = inbox(dataDir);
  await until(() => door.state.writes.length > 0, "the held Stop delivered");
  expect(door.state.writes.map((w) => [w.route, w.body.run])).toEqual([["scheduled/sch_1/stop", "msg_run_0855"]]);
  await Bun.sleep(150);
  expect(door.state.writes.some((w) => w.route.endsWith("/run"))).toBe(false);
  expect(second.studio()?.state).toBe("online");
});

test("Studio online: Run once now from this window goes there at the press, keyed and with the window's mark, and its 202 is the run", async () => {
  const door = studioDoor();
  const { call, studio } = inbox(linked(door.url));
  await until(() => studio()?.state === "online" && studio()?.list_cursor === 1, "Studio online");
  const run = await call("POST", `/api/inbox/m/${FAR}/scheduled/sch_1/run`, { idempotency_key: "run-1" });
  expect([run.status, run.body?.message_id, run.body?.scheduled?.state]).toEqual([202, "msg_run_1", "running"]);
  expect(door.state.writes.map((w) => [w.route, w.body.idempotency_key, w.body.serverSession, w.window])).toEqual([["scheduled/sch_1/run", "run-1", undefined, true]]);
});

test("a turn off pressed while Studio is away, its run still going there: held, shown off and running, and taken there exactly once when it is back", async () => {
  const door = studioDoor();
  door.state.running = true;
  const { machines, call, studio } = inbox(linked(door.url));
  await until(() => studio()?.state === "online" && studio()?.list_cursor === 1, "Studio online");
  expect((await machines.farRoutines.read()).map((one) => one.rows.map((r) => [r.enabled, r.state]))).toEqual([[[true, "running"]]]);

  door.away();
  await until(() => studio()?.state !== "online", "Studio away");
  expect((await call("POST", `/api/inbox/m/${FAR}/scheduled/sch_1/off`, { idempotency_key: "off-1" })).status).toBe(202);
  // The person's turn shows on the last-known row; the run going there keeps the row "running".
  const [held] = await machines.farRoutines.read();
  expect([held!.away, held!.rows.map((r) => [r.enabled, r.state])]).toEqual([true, [[false, "running"]]]);

  door.back();
  await until(() => door.state.writes.length > 0, "the held turn off delivered");
  await until(() => studio()?.state === "online", "Studio back");
  // Its line drops and comes back once more: every hello drains the outbox, and a settled write never goes again.
  door.away();
  await until(() => studio()?.state !== "online", "Studio away again");
  door.back();
  await until(() => studio()?.state === "online", "Studio back again");
  await Bun.sleep(150);
  expect(door.state.writes.map((w) => [w.route, w.body.idempotency_key, w.window])).toEqual([["scheduled/sch_1/off", "off-1", true]]);
  expect((await call("GET", "/api/inbox/outbox")).body.waiting).toEqual([]);
  const [now] = await machines.farRoutines.read();
  expect([now!.away, now!.rows.map((r) => [r.enabled, r.state])]).toEqual([false, [[false, "running"]]]);
});

test("a held edit stays on Studio's last-known row on every read (a reload too) until Studio takes it", async () => {
  const door = studioDoor();
  const { machines, call, studio } = inbox(linked(door.url));
  await until(() => studio()?.state === "online" && studio()?.list_cursor === 1, "Studio online");
  expect((await machines.farRoutines.read()).map((one) => [one.away, one.rows.map((r) => r.name)])).toEqual([[false, ["Morning digest"]]]);

  door.away();
  await until(() => studio()?.state !== "online", "Studio away");
  expect((await call("POST", `/api/inbox/m/${FAR}/scheduled/sch_1`, { idempotency_key: "edit-1", name: "Evening digest" })).status).toBe(202);
  // Read again, and again as a reloaded page does: the edit shows, Studio marked away with when it last said.
  for (let i = 0; i < 2; i++) {
    const [one] = await machines.farRoutines.read();
    expect([one!.away, one!.rows.map((r) => r.name), typeof one!.read_at]).toEqual([true, ["Evening digest"], "string"]);
  }

  door.back();
  await until(() => door.state.writes.length === 1, "the held write delivered");
  await until(() => studio()?.state === "online", "Studio back");
  const [now] = await machines.farRoutines.read();
  expect([now!.away, now!.rows.map((r) => r.name)]).toEqual([false, ["Evening digest"]]);
});

