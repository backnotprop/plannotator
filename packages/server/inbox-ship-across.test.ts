/**
 * One pull request ships once across computers (inbox-ship-watch.ts `onStart` / `newer`, route `ships/newer`): two
 * computers in process, each with its own ship records, watch, routes and a real outbox; a held write is applied by the
 * other computer's real route. No Inbox is started, nothing is bound. What regresses here: two agents pushing and
 * merging one pull request because the window that pressed Ship had not read the other computer, or it was asleep.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shipActive } from "@plannotator/core/inbox-pull-handoff";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { InboxOutbox } from "./inbox-outbox";
import { createInboxShipRoutes } from "./inbox-ship-routes";
import { createInboxShipStore, type InboxShipStore } from "./inbox-ship-store";
import { createInboxShipWatch, type InboxShipWatch } from "./inbox-ship-watch";

const KEY = "github.com/harbor/fern-api#614";
const PULL = { key: KEY, platform: "github", url: "https://github.com/harbor/fern-api/pull/614", title: "Receipts", number: 614, repo: "harbor/fern-api", host: "github.com", state: "open", head: "receipts", base: "main", head_repo: "harbor/fern-api", mine: true, author: "charlie-dunn" } as InboxPull;

interface Computer {
  name: string;
  id: string;
  dir: string;
  awake: boolean;
  outbox: InboxOutbox;
  ships: InboxShipStore;
  watch: InboxShipWatch;
  stops: string[];
  routes: ReturnType<typeof createInboxShipRoutes>;
  other: Computer | null;
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const clock = { now: Date.parse("2026-11-24T14:00:00.000Z") };

/** `skewMs`: how far this computer's clock is off (a Mac mini 3 minutes slow is -180_000). */
function computer(name: string, letter: string, skewMs = 0): Computer {
  const dir = mkdtempSync(join(tmpdir(), `ship-across-${name.toLowerCase()}-`));
  const c = { name, id: `ibx_${"0".repeat(25)}${letter}`, dir, awake: true, stops: [] as string[], other: null } as unknown as Computer;
  c.outbox = InboxOutbox.open(join(dir, "data"), () => new Date(clock.now + skewMs));
  c.ships = createInboxShipStore(join(dir, "data"));
  let answers = 0;
  c.watch = createInboxShipWatch({
    ships: c.ships,
    read: async () => null,
    note: (_ship, _body, kind) => {
      if (kind === "stop") c.stops.push(_ship.agent.session ?? "");
    },
    // As the Inbox does: every linked computer hears of the ship, through the outbox (held while it is asleep); an
    // answer goes to the one computer whose older ship's word arrived.
    onStart: (ship, to) => {
      if (!c.other) return;
      answers += 1;
      c.outbox.submit(c.other.id, "ships/newer", { key: ship.key, id: ship.id, started_at: ship.started_at, generation: ship.generation, idempotency_key: `ship-newer-${ship.id}-${c.other.id}${to ? `-${answers}` : ""}` }, null, false, null, true);
    },
    now: () => clock.now + skewMs,
    everyMs: 60 * 60_000,
  });
  closers.push(() => c.watch.close());
  c.routes = createInboxShipRoutes({
    ships: c.ships,
    watch: c.watch,
    serverSession: `s-${letter}`,
    json: (body, status = 200) => Response.json(body, { status }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    findPull: async () => PULL,
    threadProject: () => "prj_fern",
    threadAgent: () => null,
    repoProjects: async () => ({}),
    sendInstruction: async ({ to }) => ({ agent: { host: "claude-code", session: "session" in to ? to.session : "launch:x", name: null }, message_id: `msg_${letter}` }),
    // The door names the linked computer the request came from.
    fromMachine: (req) => {
      const from = req.headers.get("x-test-machine");
      return from && c.other && from === c.other.id ? { id: c.other.id, name: c.other.name } : null;
    },
    guard: () => null,
  });
  return c;
}

/** The sender loop from `here` to `there`: each held write applied by `there`'s own route, as its door applies it. */
const drain = (here: Computer) =>
  here.outbox.drain(here.other!.id, async (entry) => {
    const there = here.other!;
    if (!there.awake) return null;
    const path = `/api/inbox/${entry.route}`;
    const res = await there.routes(new Request(`http://door.local${path}`, { method: "POST", body: JSON.stringify(entry.body), headers: { "x-test-machine": here.id } }), path, new URL(`http://door.local${path}`));
    return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
  });

function linked(miniSkewMs = 0) {
  const studio = computer("Studio", "S");
  const mini = computer("Mac mini", "M", miniSkewMs);
  studio.other = mini;
  mini.other = studio;
  return { studio, mini };
}

const ship = async (c: Computer, session: string) => {
  clock.now += 60_000;
  const path = "/api/inbox/ships";
  const res = await c.routes(new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify({ key: KEY, thread_id: `msg_thread_${c.name}`, to: { host: "claude-code", session }, idempotency_key: `k-${session}` }) }), path, new URL(`http://127.0.0.1${path}`));
  expect(res!.status).toBe(200);
};
const active = (c: Computer) => {
  const one = c.ships.get(KEY);
  return !!one && shipActive(one);
};

describe("one ship per pull request across computers", () => {
  test("a second Ship on the other computer stops the first, whether or not any window read it", async () => {
    const { studio, mini } = linked();
    await ship(studio, "ses_studio");
    await drain(studio);
    await ship(mini, "ses_mini");
    await drain(mini);
    await drain(studio);
    expect(active(studio)).toBe(false);
    expect(studio.ships.get(KEY)!.log.at(-1)!.text).toBe("Stopped: shipping on Mac mini");
    expect(studio.stops).toEqual(["ses_studio"]);
    expect(active(mini)).toBe(true);
    expect(mini.stops).toEqual([]);
  });

  test("a Ship pressed on a computer whose clock is 3 minutes slow stops the older one on the other computer", async () => {
    const { studio, mini } = linked(-3 * 60_000);
    await ship(studio, "ses_studio");
    await drain(studio);
    // A minute later on the Mac mini, whose clock reads two minutes before the Studio's Ship.
    await ship(mini, "ses_mini");
    expect(mini.ships.get(KEY)!.started_at < studio.ships.get(KEY)!.started_at).toBe(true);
    await drain(mini);
    await drain(studio);
    expect(active(studio)).toBe(false);
    expect(studio.stops).toEqual(["ses_studio"]);
    expect(active(mini)).toBe(true);
    expect(mini.stops).toEqual([]);
  });

  test("a computer asleep at the Ship stops its own when it is back, after its Inbox restarted too", async () => {
    const { studio, mini } = linked();
    await ship(studio, "ses_studio");
    await drain(studio);
    studio.awake = false;
    await ship(mini, "ses_mini");
    await drain(mini);
    expect(active(studio)).toBe(true);
    // The Mac mini's Inbox restarts: its outbox is read again from disk.
    mini.outbox = InboxOutbox.open(join(mini.dir, "data"), () => new Date(clock.now));
    studio.awake = true;
    await drain(mini);
    expect(active(studio)).toBe(false);
    expect(active(mini)).toBe(true);
  });

  test("two Ships made while the computers could not reach each other: once both are back, exactly one goes on", async () => {
    const { studio, mini } = linked();
    studio.awake = false;
    mini.awake = false;
    await ship(studio, "ses_studio");
    await ship(mini, "ses_mini");
    studio.awake = true;
    mini.awake = true;
    // Neither press knew of the other: the same generation. Only then do the press times each computer recorded decide:
    // the Mini's press, a minute later, goes on, whatever the ids, the same way on both.
    expect(studio.ships.get(KEY)!.generation).toBe(mini.ships.get(KEY)!.generation);
    await drain(studio);
    await drain(mini);
    await drain(studio);
    expect([active(studio), active(mini)].filter(Boolean)).toHaveLength(1);
    expect(active(mini)).toBe(true);
    expect(studio.stops).toEqual(["ses_studio"]);
  });
});
