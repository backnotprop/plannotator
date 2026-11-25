/**
 * One set of Settings → Capabilities switches across linked computers (inbox-capability-set.ts). No Inbox runs: two
 * computers are two sets over stand-in switches, meeting as their lists do (each takes the other's `capability_set`);
 * the link part is this Inbox's real machines and PeerLink against a stand-in far door on loopback
 * (PLANNOTATOR_TEST_SANDBOX lets the transport take it).
 *
 * What regresses: a flip on one computer not applied on the other, or the older flip winning; a computer that was away
 * keeping its old switch when it is back; two computers that both flipped while apart settling on different answers;
 * first contact (no flip recorded on either side): an untouched default beating the person's choice on the other
 * computer (on or off), or two choices that disagree turning off what one of them uses; a choice with no time beating a
 * recorded flip; a switch an env var forces given as a flip, or a far flip turning it; a flip made right after taking
 * a far one losing to it on a slower clock; the person's flip made while a take waits turned back or its time lost; a
 * switch at its untouched default on one computer taken by another (a choice made up there, which in a chain of three
 * overrode the person's off); a computer whose clock runs days ahead, or a time near 2^53, undoing a later click on
 * another computer on every read (writing and telling each time), or carried into the stamp of that click; a take telling the
 * linked computers when nothing changed, or not telling them when it copied only a time (a third computer never
 * hears); an older Plannotator's list taken (it keeps its own); this Inbox not asking for the event that says a flip
 * was made.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_CAPABILITY_SET_KEYS, type InboxCapabilitySetKey } from "@plannotator/core/inbox-types";
import { CAPABILITY_FLIP_AHEAD_MS, CAPABILITY_SET_MARK, capabilityFlipWins, capabilitySetKeysIn, compareCapabilityFlips, createCapabilitySet, readCapabilitySet, type CapabilitySet } from "./inbox-capability-set";
import { createInboxMachines } from "./inbox-machines";
import { InboxLinks } from "./inbox-links";

const LAPTOP = `ibx_${"0".repeat(25)}1`;
const STUDIO = `ibx_${"0".repeat(25)}2`;
const MINI = `ibx_${"0".repeat(25)}3`;

/**
 * One computer: its switches, its config.json flips, its clock, what it turned and how often it told its links.
 * `start`: switches the person chose before flips were kept (their keys set); `defaults`: switches at an untouched
 * default that is on (Chapter diagrams); every other switch is at its untouched default, off. `slow`: switches whose
 * save waits (Routines' login item) until `release()`.
 */
function computer(
  id: string,
  start: Partial<Record<InboxCapabilitySetKey, boolean>> = {},
  options: { forced?: InboxCapabilitySetKey[]; clock?: number; failing?: InboxCapabilitySetKey[]; defaults?: InboxCapabilitySetKey[]; slow?: InboxCapabilitySetKey[] } = {},
) {
  const on = Object.fromEntries(INBOX_CAPABILITY_SET_KEYS.map((key) => [key, start[key] ?? options.defaults?.includes(key) ?? false])) as Record<InboxCapabilitySetKey, boolean>;
  const chosen = new Set<InboxCapabilitySetKey>(Object.keys(start) as InboxCapabilitySetKey[]);
  let config: Record<string, unknown> | undefined;
  const applied: string[] = [];
  const state = { clock: options.clock ?? 1_000, told: 0, writes: 0 };
  let release = () => {};
  const set = createCapabilitySet({
    switches: Object.fromEntries(
      INBOX_CAPABILITY_SET_KEYS.map((key) => [
        key,
        {
          on: () => on[key],
          chosen: () => chosen.has(key),
          shared: () => !options.forced?.includes(key),
          apply: (value: boolean) => {
            if (options.failing?.includes(key)) throw new Error("config.json could not be saved");
            applied.push(`${key} ${value}`);
            on[key] = value;
            chosen.add(key);
            // Saved at once, as Routines' switch is; then the wait for its login item.
            if (options.slow?.includes(key)) return new Promise<void>((resolve) => (release = resolve));
          },
        },
      ]),
    ) as never,
    times: () => config,
    // As saveConfig merges `inboxCapabilityFlips`: key by key.
    saveTimes: (times) => {
      state.writes++;
      config = { ...config, ...structuredClone(times) };
    },
    self: () => id,
    now: () => state.clock,
  });
  set.subscribe(() => state.told++);
  return {
    on,
    set,
    applied,
    state,
    flips: () => config,
    release: () => release(),
    /** The person's row: the switch saves, then the settings route stamps the flip. */
    flip(key: InboxCapabilitySetKey, value: boolean, at = state.clock) {
      state.clock = at;
      on[key] = value;
      chosen.add(key);
      set.flipped([key]);
    },
  };
}
type Computer = ReturnType<typeof computer>;

/** Two linked computers read each other's lists (in either order). */
async function meet(a: Computer, b: Computer) {
  await a.set.take(b.set.wire());
  await b.set.take(a.set.wire());
}

describe("one set of switches across linked computers", () => {
  test("a flip on one applies on the other, both ways, the newer flip winning", async () => {
    const laptop = computer(LAPTOP);
    const studio = computer(STUDIO);
    laptop.flip("board", true, 1_000);
    await meet(laptop, studio);
    expect([laptop.on.board, studio.on.board, studio.applied]).toEqual([true, true, ["board true"]]);
    // Taken as of the person's flip there, never as a new one here.
    expect(studio.set.wire().board).toEqual({ on: true, at: 1_000, by: LAPTOP });
    studio.flip("board", false, 2_000);
    await meet(studio, laptop);
    expect([laptop.on.board, studio.on.board, laptop.applied]).toEqual([false, false, ["board false"]]);
    // Met again: nothing more turns.
    await meet(laptop, studio);
    expect([laptop.applied.length, studio.applied.length]).toEqual([1, 1]);
  });

  test("a computer away while a switch flips takes it when it is back", async () => {
    const laptop = computer(LAPTOP);
    const studio = computer(STUDIO, { steps: true });
    await meet(laptop, studio);
    // Studio is away: Laptop's flip waits for the next meeting, with its time.
    laptop.flip("steps", false, 5_000);
    expect(studio.on.steps).toBe(true);
    await studio.set.take(laptop.set.wire());
    expect([studio.on.steps, studio.set.wire().steps]).toEqual([false, { on: false, at: 5_000, by: LAPTOP }]);
  });

  test("both flipped while apart: the newer flip of each switch wins, the same on both, whichever reads first", async () => {
    for (const order of ["laptop first", "studio first"]) {
      const laptop = computer(LAPTOP);
      const studio = computer(STUDIO);
      laptop.flip("board", true, 1_000);
      studio.flip("board", false, 3_000);
      laptop.flip("steps", true, 4_000);
      studio.flip("steps", false, 2_000);
      if (order === "laptop first") await meet(laptop, studio);
      else await meet(studio, laptop);
      expect([order, laptop.on.board, studio.on.board, laptop.on.steps, studio.on.steps]).toEqual([order, false, false, true, true]);
    }
  });

  test("first contact, a switch chosen on one side and at its default on the other: the choice wins, on or off", async () => {
    for (const order of ["laptop first", "studio first"]) {
      // Laptop's person turned Chapter diagrams off and Routines on before flips were kept; Studio's never touched them
      // (Chapter diagrams is on by default).
      const laptop = computer(LAPTOP, { chapter_diagrams: false, scheduled_threads: true });
      const studio = computer(STUDIO, {}, { defaults: ["chapter_diagrams"] });
      // Both sides tell a choice (0) from an untouched default (null) across the wire.
      expect([laptop.set.wire().chapter_diagrams, studio.set.wire().chapter_diagrams]).toEqual([{ on: false, at: 0, by: null }, { on: true, at: null, by: null }]);
      if (order === "laptop first") await meet(laptop, studio);
      else await meet(studio, laptop);
      expect([order, laptop.on.chapter_diagrams, studio.on.chapter_diagrams, laptop.on.scheduled_threads, studio.on.scheduled_threads]).toEqual([order, false, false, true, true]);
      expect(laptop.applied).toEqual([]);
      // Nobody flipped anything since: no time is recorded on either side.
      expect([laptop.flips(), studio.flips()]).toEqual([undefined, undefined]);
    }
  });

  test("first contact, two choices that disagree with no flip time: on wins, so nothing in use on one computer goes away", async () => {
    const laptop = computer(LAPTOP, { scheduled_threads: true, grid: true });
    const studio = computer(STUDIO, { bro: true, scheduled_threads: false, grid: false });
    await meet(laptop, studio);
    for (const key of ["scheduled_threads", "grid", "bro"] as const) expect([key, laptop.on[key], studio.on[key]]).toEqual([key, true, true]);
    expect([laptop.on.board, studio.on.board]).toEqual([false, false]);
    // Neither person flipped it since: a choice, with no time.
    expect(studio.set.wire().scheduled_threads).toEqual({ on: true, at: 0, by: null });
    expect(studio.flips()).toBeUndefined();
  });

  test("a recorded flip beats a choice with no time, either way", async () => {
    const laptop = computer(LAPTOP, { steps: true, bro: false });
    const studio = computer(STUDIO);
    studio.flip("steps", false, 500);
    studio.flip("bro", true, 500);
    await meet(laptop, studio);
    expect([laptop.on.steps, studio.on.steps, laptop.on.bro, studio.on.bro]).toEqual([false, false, true, true]);
  });

  test("a side with a recorded flip beats a side without, even off over on", async () => {
    const laptop = computer(LAPTOP, { code_review: true });
    const studio = computer(STUDIO);
    studio.flip("code_review", false, 1_000);
    await meet(laptop, studio);
    expect([laptop.on.code_review, studio.on.code_review]).toEqual([false, false]);
  });

  test("the same time on both: the higher Inbox id stands, on either computer", () => {
    const a = { on: true, at: 1_000, by: LAPTOP };
    const b = { on: false, at: 1_000, by: STUDIO };
    expect([compareCapabilityFlips(b, a) > 0, compareCapabilityFlips(a, b) < 0]).toEqual([true, true]);
    // A switch at its untouched default there is never taken, even over one at its default here.
    expect(capabilityFlipWins({ on: true, at: null, by: null }, { on: false, at: null, by: null })).toBe(false);
  });

  test("a switch at its untouched default is never taken: in a chain of three, the person's off stands on every computer", async () => {
    // Chapter diagrams: at its default on Laptop (on) and on Studio (another version: off); Mini's person turned it off.
    const laptop = computer(LAPTOP, {}, { defaults: ["chapter_diagrams"] });
    const studio = computer(STUDIO);
    const mini = computer(MINI, { chapter_diagrams: false });
    // Studio reads Laptop: nothing is turned or written, and Studio still gives it as never flipped.
    await studio.set.take(laptop.set.wire());
    expect([studio.applied, studio.flips(), studio.state.told, studio.set.wire().chapter_diagrams]).toEqual([[], undefined, 0, { on: false, at: null, by: null }]);
    // Linked in a chain, Laptop to Studio to Mini, in either order of reading.
    for (let round = 0; round < 3; round++) {
      await meet(laptop, studio);
      await meet(mini, studio);
    }
    expect([laptop.on.chapter_diagrams, studio.on.chapter_diagrams, mini.on.chapter_diagrams, mini.applied]).toEqual([false, false, false, []]);
  });

  test("a flip made right after taking a far one stands over it, though this computer's clock is behind", async () => {
    const laptop = computer(LAPTOP, {}, { clock: 9_000 });
    const studio = computer(STUDIO, {}, { clock: 1_000 });
    laptop.flip("float_drafts", true);
    await meet(laptop, studio);
    studio.flip("float_drafts", false);
    expect(studio.set.wire().float_drafts).toEqual({ on: false, at: 9_001, by: STUDIO });
    await meet(studio, laptop);
    expect([laptop.on.float_drafts, studio.on.float_drafts]).toEqual([false, false]);
  });

  test("a switch an env var forces here is neither given nor taken, and stays as it is forced", async () => {
    const laptop = computer(LAPTOP, { decision_mode: true }, { forced: ["decision_mode"] });
    const studio = computer(STUDIO);
    expect(laptop.set.wire().decision_mode).toBeUndefined();
    await meet(laptop, studio);
    expect([laptop.on.decision_mode, studio.on.decision_mode]).toEqual([true, false]);
    studio.flip("decision_mode", false, 2_000);
    laptop.flip("decision_mode", true, 3_000);
    await meet(laptop, studio);
    expect([laptop.on.decision_mode, studio.on.decision_mode, laptop.applied, studio.applied]).toEqual([true, false, [], []]);
    // The forced computer recorded no flip for it either.
    expect(laptop.flips()).toBeUndefined();
  });

  test("a take that turns something tells the linked computers (so a third one hears); one that turns nothing does not", async () => {
    const laptop = computer(LAPTOP);
    const studio = computer(STUDIO);
    laptop.flip("bro", true, 1_000);
    expect(laptop.state.told).toBe(1);
    await studio.set.take(laptop.set.wire());
    expect(studio.state.told).toBe(1);
    await studio.set.take(laptop.set.wire());
    await laptop.set.take(studio.set.wire());
    expect([laptop.state.told, studio.state.told]).toEqual([1, 1]);
  });

  test("a time copied with nothing to turn is told too, so a third computer hears it; the next exchange sends nothing", async () => {
    const laptop = computer(LAPTOP);
    const studio = computer(STUDIO, { bro: true });
    const mini = computer(MINI, { bro: true });
    laptop.flip("bro", true, 1_000);
    // Studio, linked to both, already had it on: only the time is stored, and its links are told.
    await studio.set.take(laptop.set.wire());
    expect([studio.applied, studio.set.wire().bro, studio.state.told]).toEqual([[], { on: true, at: 1_000, by: LAPTOP }, 1]);
    // Mini, linked to Studio only, reads Studio's list on that event and takes the time.
    await mini.set.take(studio.set.wire());
    expect([mini.set.wire().bro, mini.state.told]).toEqual([{ on: true, at: 1_000, by: LAPTOP }, 1]);
    // Every exchange after that compares equal: nothing is stored or told, so nothing loops.
    const told = [laptop.state.told, studio.state.told, mini.state.told];
    for (const [a, b] of [[laptop, studio], [studio, mini], [mini, studio], [studio, laptop]] as const) await a.set.take(b.set.wire());
    expect([laptop.state.told, studio.state.told, mini.state.told]).toEqual(told);
  });

  test("the person's flip here while a take waits (Routines' login item) stands: not turned back, its time kept", async () => {
    const laptop = computer(LAPTOP);
    const studio = computer(STUDIO, { bro: true }, { slow: ["scheduled_threads"] });
    studio.flip("board", false, 500);
    laptop.flip("scheduled_threads", true, 1_000);
    laptop.flip("bro", true, 1_000);
    const taking = studio.set.take(laptop.set.wire());
    await Bun.sleep(5);
    expect(studio.applied).toEqual(["scheduled_threads true"]);
    // Meanwhile, in Studio's Settings: Bro mode off, Board on.
    studio.flip("bro", false, 2_000);
    studio.flip("board", true, 2_000);
    studio.release();
    await taking;
    expect([studio.on.scheduled_threads, studio.on.bro, studio.on.board]).toEqual([true, false, true]);
    expect(studio.flips()).toEqual({ board: { at: 2_000, by: STUDIO }, bro: { at: 2_000, by: STUDIO }, scheduled_threads: { at: 1_000, by: LAPTOP } });
    // And the person's flips go on to Laptop.
    await laptop.set.take(studio.set.wire());
    expect([laptop.on.bro, laptop.on.board]).toEqual([false, true]);
  });

  test("a computer whose clock runs two days ahead: its flip is taken once, a later click here wins and stays, and reads after it change nothing", async () => {
    const DAY = CAPABILITY_FLIP_AHEAD_MS;
    const T = 100 * DAY;
    for (const value of [true, false]) {
      // Laptop's clock is right; Studio's runs two days ahead. Laptop's person chose the other way before flips were kept.
      const laptop = computer(LAPTOP, { steps: !value }, { clock: T });
      const studio = computer(STUDIO, {}, { clock: T + 2 * DAY });
      studio.flip("steps", value);
      await laptop.set.take(studio.set.wire());
      expect([value, laptop.on.steps, laptop.applied, laptop.state.told]).toEqual([value, value, [`steps ${value}`], 1]);
      // Stored as it came: Laptop gives Studio's time on unchanged.
      expect(laptop.set.wire().steps).toEqual({ on: value, at: T + 2 * DAY, by: STUDIO });
      // The person turns it back on Laptop: stamped by Laptop's clock, not carried past Studio's far time.
      laptop.flip("steps", !value, T + 1_000);
      expect(laptop.set.wire().steps).toEqual({ on: !value, at: T + 1_000, by: LAPTOP });
      // Studio keeps its own flip: by its clock, Laptop's is two days older.
      await studio.set.take(laptop.set.wire());
      expect(studio.on.steps).toBe(value);
      // Laptop reads Studio's list again and again: the click stands, and nothing is written or told.
      const { writes, told } = laptop.state;
      for (let read = 0; read < 5; read++) {
        laptop.state.clock += 60_000;
        await laptop.set.take(studio.set.wire());
      }
      expect([laptop.on.steps, laptop.applied.length, laptop.state.writes - writes, laptop.state.told - told]).toEqual([!value, 1, 0, 0]);
      // Once Studio's time is within a day of Laptop's clock it is trusted, taken once, and the two agree from then on.
      laptop.state.clock = T + DAY;
      studio.state.clock = T + 3 * DAY;
      await meet(laptop, studio);
      const settled = [laptop.state.writes, laptop.state.told, studio.state.writes, studio.state.told];
      await meet(laptop, studio);
      expect([laptop.on.steps, studio.on.steps]).toEqual([value, value]);
      expect([laptop.state.writes, laptop.state.told, studio.state.writes, studio.state.told]).toEqual(settled);
    }
  });

  test("a far time near 2^53 is not trusted: taken once as a choice at 0, a later click here wins and stays, and the far side takes it", async () => {
    const studio = computer(STUDIO, {}, { clock: 1_000 });
    const far: CapabilitySet = { grid: { on: true, at: Number.MAX_SAFE_INTEGER, by: LAPTOP } };
    await studio.set.take(far);
    expect([studio.on.grid, studio.set.wire().grid, studio.state.told]).toEqual([true, { on: true, at: Number.MAX_SAFE_INTEGER, by: LAPTOP }, 1]);
    studio.flip("grid", false, 2_000);
    expect(studio.set.wire().grid).toEqual({ on: false, at: 2_000, by: STUDIO });
    const { writes, told } = studio.state;
    for (let read = 0; read < 5; read++) {
      studio.state.clock += 1_000;
      await studio.set.take(far);
    }
    expect([studio.on.grid, studio.applied.length, studio.state.writes - writes, studio.state.told - told]).toEqual([false, 1, 0, 0]);
    // The computer that kept that time as its own does not trust it either: it takes Studio's flip, and a click there
    // is stamped by its clock, never pinned past it.
    const laptop = computer(LAPTOP, {}, { clock: 1_000 });
    laptop.flip("grid", true, Number.MAX_SAFE_INTEGER);
    laptop.state.clock = 3_000;
    await laptop.set.take(studio.set.wire());
    expect(laptop.on.grid).toBe(false);
    laptop.flip("grid", true);
    expect(laptop.set.wire().grid).toEqual({ on: true, at: 3_000, by: LAPTOP });
    await studio.set.take(laptop.set.wire());
    expect(studio.on.grid).toBe(true);
  });

  test("a switch that cannot be saved here keeps its state and its flip until the next read", async () => {
    const laptop = computer(LAPTOP);
    const studio = computer(STUDIO, {}, { failing: ["board"] });
    laptop.flip("board", true, 1_000);
    laptop.flip("steps", true, 1_000);
    await studio.set.take(laptop.set.wire());
    expect([studio.on.board, studio.on.steps, studio.set.wire().board, studio.state.told]).toEqual([false, true, { on: false, at: null, by: null }, 1]);
  });

  test("the switches a settings save names, Decision mode and Grid inside `experimental` too", () => {
    expect(capabilitySetKeysIn({ board: { on: true }, sound: {}, experimental: { grid: true } })).toEqual(["board", "grid"]);
    expect(capabilitySetKeysIn({ show_archived: { on: true } })).toEqual([]);
  });

  test("Decision mode turned from its own Capabilities row is stamped, and a linked computer takes it", async () => {
    // Its row saves `{ decision_mode: { on } }`; an older window's switch still saves `{ experimental: { decision_mode } }`.
    expect(capabilitySetKeysIn({ decision_mode: { on: false } })).toEqual(["decision_mode"]);
    expect(capabilitySetKeysIn({ experimental: { decision_mode: false } })).toEqual(["decision_mode"]);
    const laptop = computer(LAPTOP, {}, { defaults: ["decision_mode"] });
    const studio = computer(STUDIO, {}, { defaults: ["decision_mode"] });
    // The settings route stamps what a save names (inbox.ts: `capabilitySet.flipped(capabilitySetKeysIn(body))`).
    laptop.state.clock = 5_000;
    laptop.on.decision_mode = false;
    laptop.set.flipped(capabilitySetKeysIn({ decision_mode: { on: false } }));
    expect(laptop.set.wire().decision_mode).toEqual({ on: false, at: 5_000, by: LAPTOP });
    await meet(laptop, studio);
    expect([studio.on.decision_mode, studio.applied]).toEqual([false, ["decision_mode false"]]);
  });

  test("a linked computer's set is read by name: an unknown switch, a bad time or a foreign id is dropped", () => {
    expect(readCapabilitySet({ board: { on: true, at: 5, by: STUDIO }, steps: { on: "yes" }, plans: { on: true }, bro: { on: false, at: -1, by: STUDIO }, grid: { on: true, at: 7, by: "laptop" }, float_drafts: { on: false, at: 0, by: null } })).toEqual({
      board: { on: true, at: 5, by: STUDIO },
      // A choice made before flips were kept stays one across the wire.
      float_drafts: { on: false, at: 0, by: null },
      bro: { on: false, at: null, by: null },
      grid: { on: true, at: 7, by: null },
    });
    expect(readCapabilitySet(undefined)).toBeNull();
  });
});

// ── Through a real link: which lists are taken, and the event that says a flip was made there ──

const TOKEN = "tok_test";
let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-capability-set-")));
  savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
  rmSync(root, { recursive: true, force: true });
});

/** Studio's door: its list carries `capability_set` (and the mark, unless it is older); `say()` sends its stream an event. */
function studioDoor(marks: string[]) {
  const state = { down: false, set: { board: { on: true, at: 1_000, by: STUDIO } } as CapabilitySet, asked: [] as string[], lists: 0 };
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = url.pathname.replace("/api/inbox/device/", "");
      if (state.down) return new Response("away", { status: 503 });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ code: "device_token_invalid" }, { status: 401 });
      if (route === "health") return Response.json({ ok: true, inbox_id: STUDIO, machine_links: 1, version: "0.29.9" });
      if (route === "threads") {
        state.lists++;
        return Response.json({ cursor: 1, sections: [], projects: [], marks, capability_set: state.set });
      }
      if (route === "events") {
        state.asked.push(url.search);
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            streams.add(c);
            c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":1}\n\n`));
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    say(event: string) {
      for (const c of streams) c.enqueue(new TextEncoder().encode(`event: ${event}\ndata: {}\n\n`));
    },
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

function laptopMachines(url: string) {
  const dataDir = join(root, "data");
  InboxLinks.open(dataDir).put({ id: STUDIO, name: "Studio", token: TOKEN, transport: { kind: "tailnet", url }, device_id: null, linked_at: "2026-11-01T00:00:00Z" });
  const said: CapabilitySet[] = [];
  const noop = () => {};
  const machines = createInboxMachines({
    dataDir,
    serverSession: "srv",
    computerName: () => "Laptop",
    door: {
      openMachineOffer: () => ({ secret: "s", code: "000000", expires_at: "" }),
      offerDevice: () => null,
      closeMachineOffer: () => null,
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
    capabilitySetSaid: (value) => said.push(value),
    timings: { silenceMs: 60_000, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 1000, sendMs: 1000 },
  });
  cleanups.push(() => machines.stop());
  machines.start();
  const studio = () => machines.machinesView().find((m) => m.id === STUDIO);
  return { said, studio };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(20);
  if (!check()) throw new Error(`never: ${what}`);
}

describe("through a link", () => {
  test("a computer that keeps the one set: its set is taken, again when it says a flip was made and when it is back from away", async () => {
    const door = studioDoor([CAPABILITY_SET_MARK]);
    const { said, studio } = laptopMachines(door.url);
    await until(() => studio()?.state === "online" && said.length > 0, "Studio's set read");
    expect(said.at(-1)).toEqual({ board: { on: true, at: 1_000, by: STUDIO } });
    // This Inbox asks for the event that says a flip was made there.
    expect(door.state.asked.some((search) => new URLSearchParams(search).get("capability-set") === "1")).toBe(true);
    // A flip there: its stream says so, its list is read again, and the new set is taken here.
    door.state.set = { board: { on: false, at: 2_000, by: STUDIO } };
    door.say("capability-set");
    await until(() => said.at(-1)?.board?.on === false, "the flip there taken");
    // Away, then a flip there, then back: the set it has now is taken when it is back.
    door.away();
    await until(() => studio()?.state !== "online", "Studio away");
    door.state.set = { board: { on: false, at: 2_000, by: STUDIO }, steps: { on: true, at: 3_000, by: STUDIO } };
    door.back();
    await until(() => said.at(-1)?.steps?.on === true, "the set taken when Studio is back");
  });

  test("an older Plannotator (no mark) keeps its own switches: its list is read, its set never taken", async () => {
    const door = studioDoor(["capabilities", "capability-note"]);
    const { said, studio } = laptopMachines(door.url);
    await until(() => studio()?.state === "online" && door.state.lists > 0, "Studio's list read");
    door.say("capability-set");
    await Bun.sleep(150);
    expect(said).toEqual([]);
  });
});
