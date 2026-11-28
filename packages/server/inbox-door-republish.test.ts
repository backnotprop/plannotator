/**
 * The tailnet door (linked machines' way in) publishes again by itself (`INBOX_DOOR_REPUBLISH`,
 * packages/server/inbox-devices.ts): an Inbox started while Tailscale was stopped publishes its door once Tailscale
 * runs, a mapping it made itself where a connect is refused now (a crash, a stop that could not take it down) is re-pointed,
 * and a mapping it did not make, or one something still listens behind, is never touched. The module alone, with a
 * scripted `tailscale` and a hand-driven clock: no Inbox server starts; the only listeners are the door's own on
 * loopback. Temp PLANNOTATOR_DATA_DIR only; the real `tailscale` never runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { createInboxDevices, INBOX_DOOR_REPUBLISH, type InboxDoorTimers } from "./inbox-devices";
import { loopbackTargetDead, readTailnetDoorRecord, writeTailnetDoorRecord } from "./inbox-tailnet-door";

const MAGIC = "mini.example.ts.net";
const DOOR = 8443;
const WAIT = INBOX_DOOR_REPUBLISH.waitMs;

const roots: string[] = [];
const stops: (() => void)[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(): string {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-door-republish-")));
  roots.push(dataDir);
  mkdirSync(inboxDir(dataDir), { recursive: true });
  const previous = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = previous;
  });
  return dataDir;
}

/** A loopback port nothing listens on now (bound, then let go). */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

function fakeClock() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: InboxDoorTimers = {
    set: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  return {
    timers,
    waits: () => [...pending.values()].map((t) => t.ms),
    fire: async () => {
      const due = [...pending.entries()];
      for (const [id] of due) pending.delete(id);
      for (const [, t] of due) t.fn();
      // A look may probe a loopback port (two connects) before it publishes.
      await Bun.sleep(30);
    },
  };
}

/** Tailscale as a scripted CLI: running or stopped, its serve config (kept while stopped, shown only while running), every call. */
function fakeTailscale() {
  const serve = new Map<number, string>();
  const tailscale = { running: false, serveRefuses: false };
  const calls: string[][] = [];
  const run: TailscaleRunner = (args) => {
    calls.push(args);
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") {
      return ok(JSON.stringify({ BackendState: tailscale.running ? "Running" : "Stopped", Self: { DNSName: `${MAGIC}.`, UserID: 7 }, User: { "7": { ID: 7, LoginName: "owner@example.com" } } }));
    }
    if (args[1] === "status") {
      // Stopped: serve has nothing to say, though the mapping comes back with Tailscale.
      if (!tailscale.running || serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (!tailscale.running) return { status: 1, stdout: "", stderr: "Tailscale is stopped." };
    if (tailscale.serveRefuses && !args.includes("off")) return { status: 1, stdout: "", stderr: "serve is not enabled on your tailnet" };
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
  const serveWrites = () => calls.filter((args) => args[0] === "serve" && args[1] !== "status");
  return { serve, tailscale, calls, serveWrites, run };
}

/** The devices module of an Inbox with Phones off, one machine linked, and the door switch kept on from its last run. */
function door(dataDir: string, run: TailscaleRunner, clock: ReturnType<typeof fakeClock>, linked: boolean | { now: boolean } = true, phones = false) {
  const links = typeof linked === "boolean" ? { now: linked } : linked;
  const registry: InboxRegistryEntry = {
    v: 1,
    pid: process.pid,
    port: 1,
    url: "http://127.0.0.1:1",
    version: "test",
    token: "t".repeat(64),
    serverSession: "0".repeat(32),
    startedAt: new Date().toISOString(),
    tailnet: { https_port: DOOR, door_port: freePort() },
  };
  const republished: number[] = [];
  const devices = createInboxDevices({
    dataDir,
    serverSession: registry.serverSession,
    port: () => 1,
    registry: () => registry,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    dispatch: async () => new Response("ok"),
    tailscale: run,
    phones,
    machines: () => ({ hasLinks: () => links.now, linkBack: async () => new Response(null), unlinkedBy: () => new Response(null) }),
    doorTimers: clock.timers,
    onDoorRepublished: () => void republished.push(Date.now()),
  });
  stops.push(() => devices.stopTailnet());
  const view = () => ({ address: devices.machineDoor.tailnetAddress(), error: devices.machineDoor.tailnetError() });
  return { devices, republished, view, registry };
}

describe("the tailnet door publishes again by itself", () => {
  test("started while Tailscale was stopped: only `status` is read, backing off; once it runs the door is published and the windows told", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const clock = fakeClock();
    const { devices, republished, view } = door(dataDir, ts.run, clock);
    devices.startTailnet();
    expect(view().address).toBeNull();
    expect(view().error).not.toBeNull();
    expect(clock.waits()).toEqual([WAIT[0]!]);

    const before = ts.calls.length;
    for (let i = 1; i < WAIT.length + 2; i++) {
      await clock.fire();
      expect(clock.waits()).toEqual([WAIT[Math.min(i, WAIT.length - 1)]!]);
    }
    // Waiting reads Tailscale's state only: no serve call, nothing published, no notice.
    expect(ts.calls.slice(before).every((args) => args.join(" ") === "status --json")).toBe(true);
    expect(republished).toHaveLength(0);

    ts.tailscale.running = true;
    await clock.fire();
    expect(view()).toEqual({ address: `${MAGIC}:${DOOR}`, error: null });
    expect(ts.serve.get(DOOR)).toStartWith("http://127.0.0.1:");
    expect(republished).toHaveLength(1);
    // Published: a slow look that its mapping is still there.
    expect(clock.waits()).toEqual([INBOX_DOOR_REPUBLISH.checkMs]);
  });

  test("the mapping a crashed run left (its record says it made it, a connect is refused there): re-pointed at this run's door by the look that runs at once", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.running = true;
    const dead = `http://127.0.0.1:${freePort()}`;
    ts.serve.set(DOOR, dead);
    // As a take-down that read an empty `serve status` (Tailscale stopped) left it: published false, the mapping kept.
    writeTailnetDoorRecord(dataDir, { https_port: DOOR, target: dead, published: false });
    const clock = fakeClock();
    const { devices, view, republished } = door(dataDir, ts.run, clock);
    devices.startTailnet();
    // The start never probes (it would block): the mapping reads as held, and a look runs at once.
    expect(view().address).toBeNull();
    expect(clock.waits()).toEqual([0]);
    await clock.fire();
    expect(view()).toEqual({ address: `${MAGIC}:${DOOR}`, error: null });
    expect(republished).toHaveLength(1);
    expect(ts.serve.get(DOOR)).not.toBe(dead);
    expect(readTailnetDoorRecord(dataDir)).toMatchObject({ published: true, target: ts.serve.get(DOOR), made: expect.arrayContaining([dead, ts.serve.get(DOOR)]) });
  });

  test("Tailscale stopped at start with that leftover: nothing taken down meanwhile, and the door is re-pointed once Tailscale runs", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const dead = `http://127.0.0.1:${freePort()}`;
    ts.serve.set(DOOR, dead);
    writeTailnetDoorRecord(dataDir, { https_port: DOOR, target: dead, published: true });
    const clock = fakeClock();
    const { devices, republished, view } = door(dataDir, ts.run, clock);
    devices.startTailnet();
    expect(view().address).toBeNull();
    expect(readTailnetDoorRecord(dataDir)?.target).toBe(dead);
    ts.tailscale.running = true;
    await clock.fire();
    expect(view().address).toBe(`${MAGIC}:${DOOR}`);
    expect(ts.serve.get(DOOR)).not.toBe(dead);
    expect(republished).toHaveLength(1);
  });

  test("a mapping this Inbox did not make: never touched, the words unchanged, looked at again after 10, then 30 minutes", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.running = true;
    const theirs = `http://127.0.0.1:${freePort()}`;
    ts.serve.set(DOOR, theirs);
    writeTailnetDoorRecord(dataDir, { https_port: DOOR, target: `http://127.0.0.1:${freePort()}`, published: false });
    const clock = fakeClock();
    const { devices, view } = door(dataDir, ts.run, clock);
    devices.startTailnet();
    expect(clock.waits()).toEqual([0]);
    expect(view().address).toBeNull();
    expect(view().error).toStartWith(`Another tailscale serve mapping now uses port ${DOOR}, where linked machines reach this Inbox.`);
    expect(ts.serve.get(DOOR)).toBe(theirs);
    const words = view().error;
    for (const wait of [...INBOX_DOOR_REPUBLISH.stuckMs, INBOX_DOOR_REPUBLISH.stuckMs.at(-1)!]) {
      await clock.fire();
      expect(clock.waits()).toEqual([wait]);
    }
    // Looks read only: no serve write, the same words.
    expect(ts.serve.get(DOOR)).toBe(theirs);
    expect(ts.serveWrites()).toEqual([]);
    expect(view().error).toBe(words);
  });

  test("a mapping it made whose port something listens on now (on 0.0.0.0): never touched", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.running = true;
    const live = createServer(() => {});
    await new Promise<void>((resolve) => live.listen(0, "0.0.0.0", resolve));
    try {
      const target = `http://127.0.0.1:${(live.address() as { port: number }).port}`;
      ts.serve.set(DOOR, target);
      writeTailnetDoorRecord(dataDir, { https_port: DOOR, target, published: false });
      const clock = fakeClock();
      const { devices, view } = door(dataDir, ts.run, clock);
      devices.startTailnet();
      await clock.fire();
      expect(view().address).toBeNull();
      expect(view().error).toStartWith(`Another tailscale serve mapping now uses port ${DOOR}`);
      expect(ts.serve.get(DOOR)).toBe(target);
      expect(ts.serveWrites()).toEqual([]);
      expect(clock.waits()).toEqual([INBOX_DOOR_REPUBLISH.stuckMs[0]!]);
    } finally {
      await new Promise<void>((resolve) => live.close(() => resolve()));
    }
  });

  test("a clean stop while Tailscale is stopped keeps the record (serve's empty answer proves nothing); the next start with Tailscale back takes its mapping back", () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.running = true;
    const first = door(dataDir, ts.run, fakeClock());
    first.devices.startTailnet();
    const left = ts.serve.get(DOOR)!;
    expect(left).toStartWith("http://127.0.0.1:");
    ts.tailscale.running = false;
    first.devices.stopTailnet();
    // The mapping stays with Tailscale, and so does the record of it.
    expect(ts.serve.get(DOOR)).toBe(left);
    expect(readTailnetDoorRecord(dataDir)).toMatchObject({ https_port: DOOR, target: left, published: true, made: [left] });

    ts.tailscale.running = true;
    const next = door(dataDir, ts.run, fakeClock());
    next.devices.startTailnet();
    expect(next.view()).toEqual({ address: `${MAGIC}:${DOOR}`, error: null });
    expect(readTailnetDoorRecord(dataDir)).toMatchObject({ published: true, target: ts.serve.get(DOOR) });
  });

  test("a reboot (#3591): the clean stop misreads Tailscale shutting down and believes the mapping gone; Tailscale brings it back at boot, and the door takes it back", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.running = true;
    const box = { shuttingDown: false };
    const run: TailscaleRunner = (args, ms) => {
      if (box.shuttingDown && args[0] === "serve" && args[1] === "status") return { status: 0, stdout: "{}", stderr: "" };
      if (box.shuttingDown && args[0] === "status") return { status: 1, stdout: "", stderr: "failed to connect to local tailscaled" };
      return ts.run(args, ms);
    };
    const first = door(dataDir, run, fakeClock());
    first.devices.startTailnet();
    const left = ts.serve.get(DOOR)!;
    box.shuttingDown = true;
    first.devices.stopTailnet();
    box.shuttingDown = false;
    expect(ts.serve.get(DOOR)).toBe(left);

    const clock = fakeClock();
    const next = door(dataDir, run, clock);
    next.devices.startTailnet();
    if (clock.waits().includes(0)) await clock.fire();
    expect(next.view()).toEqual({ address: `${MAGIC}:${DOOR}`, error: null });
    expect(ts.serve.get(DOOR)).not.toBe(left);
    expect(readTailnetDoorRecord(dataDir)).toMatchObject({ published: true, target: ts.serve.get(DOOR) });
  });

  test("the door switched off while Tailscale is stopped: off at once, its listener closed, the record kept; the mapping is taken down once Tailscale runs, by a status-only look", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.running = true;
    const clock = fakeClock();
    // Phones on: the person's own switch in Settings.
    const { devices, view, registry } = door(dataDir, ts.run, clock, false, true);
    devices.startTailnet();
    const target = ts.serve.get(DOOR)!;
    expect(view().address).toBe(`${MAGIC}:${DOOR}`);
    ts.tailscale.running = false;
    const off = await devices.windowRoute(
      new Request("http://127.0.0.1:1/api/inbox/tailnet", { method: "POST", body: JSON.stringify({ on: false, serverSession: registry.serverSession }) }),
      new URL("http://127.0.0.1:1/api/inbox/tailnet"),
    );
    expect(off!.status).toBe(200);
    expect(((await off!.json()) as { tailnet: { on: boolean } }).tailnet.on).toBe(false);
    expect(registry.tailnet).toBeUndefined();
    expect(view().address).toBeNull();
    expect(await loopbackTargetDead(target)).toBe(true);
    expect(readTailnetDoorRecord(dataDir)).toMatchObject({ https_port: DOOR, target, published: true });
    expect(clock.waits()).toEqual([WAIT[0]!]);
    ts.calls.length = 0;
    await clock.fire();
    expect(ts.calls).toEqual([["status", "--json"]]);
    expect(clock.waits()).toEqual([WAIT[1]!]);

    ts.tailscale.running = true;
    await clock.fire();
    expect(ts.serve.has(DOOR)).toBe(false);
    expect(readTailnetDoorRecord(dataDir)).toBeNull();
    expect(clock.waits()).toEqual([]);
  });

  test("the last machine unlinked while Tailscale is stopped: the door closes and the switch clears; the mapping comes down once Tailscale runs", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.running = true;
    const clock = fakeClock();
    const links = { now: true };
    const { devices, view, registry } = door(dataDir, ts.run, clock, links);
    devices.startTailnet();
    const target = ts.serve.get(DOOR)!;
    ts.tailscale.running = false;
    links.now = false;
    devices.machineDoor.closeTailnetIfUnused();
    expect(registry.tailnet).toBeUndefined();
    expect(view().address).toBeNull();
    expect(await loopbackTargetDead(target)).toBe(true);
    expect(clock.waits()).toEqual([WAIT[0]!]);

    // A restart meanwhile: the switch is off, the take-down still owed; the start looks without blocking.
    const next = door(dataDir, ts.run, fakeClock(), false);
    next.registry.tailnet = undefined;
    ts.calls.length = 0;
    next.devices.startTailnet();
    expect(ts.calls).toEqual([]);

    ts.tailscale.running = true;
    await clock.fire();
    expect(ts.serve.has(DOOR)).toBe(false);
    expect(readTailnetDoorRecord(dataDir)).toBeNull();
    expect(clock.waits()).toEqual([]);
  });

  test("Tailscale runs but serve refuses (Serve off for the tailnet): no 5-minute loop; looked at again after 10, then 30 minutes", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const clock = fakeClock();
    const { devices, view } = door(dataDir, ts.run, clock);
    devices.startTailnet();
    expect(clock.waits()).toEqual([WAIT[0]!]);
    ts.tailscale.running = true;
    ts.tailscale.serveRefuses = true;
    await clock.fire();
    expect(view().address).toBeNull();
    expect(clock.waits()).toEqual([INBOX_DOOR_REPUBLISH.stuckMs[0]!]);
    await clock.fire();
    expect(clock.waits()).toEqual([INBOX_DOOR_REPUBLISH.stuckMs[1]!]);
    ts.tailscale.serveRefuses = false;
    await clock.fire();
    expect(view().address).toBe(`${MAGIC}:${DOOR}`);
    expect(clock.waits()).toEqual([INBOX_DOOR_REPUBLISH.checkMs]);
  });

  test("published, then Tailscale lost its serve config: the next look publishes the door again", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    ts.tailscale.running = true;
    const clock = fakeClock();
    const { devices, republished, view } = door(dataDir, ts.run, clock);
    devices.startTailnet();
    const mapped = ts.serve.get(DOOR);
    expect(mapped).toStartWith("http://127.0.0.1:");
    // Still there: a look changes nothing.
    await clock.fire();
    expect(ts.serveWrites()).toHaveLength(1);
    expect(republished).toHaveLength(0);
    // Tailscale stops for a while: the door's listener stays, and nothing is published meanwhile.
    ts.tailscale.running = false;
    await clock.fire();
    expect(view().address).toBe(`${MAGIC}:${DOOR}`);
    expect(clock.waits()).toEqual([WAIT[0]!]);
    // Back, its serve config gone: published again on the same listener.
    ts.serve.clear();
    ts.tailscale.running = true;
    await clock.fire();
    expect(ts.serve.get(DOOR)).toBe(mapped);
    expect(republished).toHaveLength(1);
    expect(clock.waits()).toEqual([INBOX_DOOR_REPUBLISH.checkMs]);
  });

  test("nothing linked (Phones off): no `tailscale` call and no timer; the stop clears a waiting look", () => {
    {
      const dataDir = world();
      const ts = fakeTailscale();
      const clock = fakeClock();
      const { devices } = door(dataDir, ts.run, clock, false);
      devices.startTailnet();
      expect(ts.calls).toEqual([]);
      expect(clock.waits()).toEqual([]);
    }
    {
      const dataDir = world();
      const ts = fakeTailscale();
      const clock = fakeClock();
      const { devices } = door(dataDir, ts.run, clock);
      devices.startTailnet();
      expect(clock.waits()).toEqual([WAIT[0]!]);
      devices.stopTailnet();
      expect(clock.waits()).toEqual([]);
    }
  });
});
