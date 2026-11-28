/**
 * Routines across linked computers, without an Inbox: the merged read's far part (stand-in links), the window route's
 * merged answer and a far window's press, and the door and forward's view of the new routes. The two-Inbox proof is
 * inbox-scheduled-linked.test.ts (CI).
 *
 * What this catches: a linked computer's routines missing from the list, or without their computer (a press would go to
 * the wrong store); an away computer's routines dropped instead of shown as last known; an older Plannotator asked (or
 * its 404 said as an error) instead of simply listing nothing; Routines off there read as a failure; a bare call or a
 * phone reaching a routine's write; a routine write forwarded without a rule 8 kind.
 */
import { describe, expect, test } from "bun:test";
import type { InboxScheduledRow } from "@plannotator/core/inbox-scheduled-types";
import { createFarRoutines, farRoutineRows, ROUTINES_MARK, type RoutinesPeer } from "./inbox-scheduled-machines";
import { scheduledRoute } from "./inbox-scheduled-routes";
import type { InboxScheduled } from "./inbox-scheduled";
import { doorRouteOf } from "./inbox-devices";
import { startsAgentThere } from "./inbox-machines";
import { withHeld, type HeldRoutineWrite } from "./inbox-scheduled-machines";

const row = (id: string, name = id): InboxScheduledRow => ({ id, name }) as unknown as InboxScheduledRow;

function peer(id: string, answer: () => Response | Promise<Response>, options: { state?: string; marks?: string[] } = {}): RoutinesPeer & { asked: number; state: string } {
  const p = {
    id,
    state: options.state ?? "online",
    list: { marks: options.marks ?? [ROUTINES_MARK] },
    asked: 0,
    request: async () => {
      p.asked += 1;
      return answer();
    },
  };
  return p;
}

describe("the merged read's linked computers", () => {
  test("online: its rows, each named as its computer; Routines off there: on false and none; an older one: not asked", async () => {
    const studio = peer("ibx_STUDIO", () => Response.json({ scheduled: [row("sch_1", "Morning triage"), { id: "not a routine", name: "x" }], launch_on: true }));
    const laptop = peer("ibx_LAPTOP", () => Response.json({ error: "Routines are off on this computer.", code: "routines_off" }, { status: 404 }));
    const older = peer("ibx_OLD", () => Response.json({ scheduled: [row("sch_9")] }), { marks: [] });
    const far = createFarRoutines(() => [studio, laptop, older]);
    const read = await far.read();
    expect(read.map((one) => [one.machine, one.on, one.away, one.rows.map((r) => [r.id, r.machine])])).toEqual([
      ["ibx_STUDIO", true, false, [["sch_1", "ibx_STUDIO"]]],
      ["ibx_LAPTOP", false, false, []],
    ]);
    expect(older.asked).toBe(0);
  });

  test("away, slow or failing: the rows it last gave, marked away; never answered: left out", async () => {
    let down = false;
    const studio = peer("ibx_STUDIO", () => {
      if (down) throw new Error("no route to host");
      return Response.json({ scheduled: [row("sch_1")], launch_on: false });
    });
    const never = peer("ibx_NEVER", () => Promise.reject(new Error("down")));
    const far = createFarRoutines(() => [studio, never]);
    expect((await far.read()).map((one) => [one.machine, one.away, one.launch_on])).toEqual([["ibx_STUDIO", false, false]]);
    down = true;
    expect((await far.read()).map((one) => [one.machine, one.away, one.rows.length])).toEqual([["ibx_STUDIO", true, 1]]);
    studio.state = "offline";
    const asked = studio.asked;
    expect((await far.read()).map((one) => [one.machine, one.away])).toEqual([["ibx_STUDIO", true]]);
    expect(studio.asked).toBe(asked);
  });

  test("a door without the route (404, no routines_off) lists nothing and is no error", async () => {
    const old = peer("ibx_OLD", () => Response.json({ error: "This isn't available from another computer.", code: "device_route_not_found" }, { status: 404 }));
    expect(await createFarRoutines(() => [old]).read()).toEqual([]);
  });

  test("a far answer's rows: only routines with a plain id and a name", () => {
    expect(farRoutineRows("ibx_A", { scheduled: [row("sch_ok"), { id: "sch_../x", name: "bad" }, { id: "sch_noname" }, null] }).map((r) => r.id)).toEqual(["sch_ok"]);
    expect(farRoutineRows("ibx_A", null)).toEqual([]);
  });
});

describe("the person's held writes on a linked computer's rows", () => {
  const full = (id: string, extra: Partial<InboxScheduledRow> = {}) =>
    ({ id, name: id, enabled: true, state: "on", schedule: { cron: "0 9 * * *", tz: "UTC" }, schedule_words: "Every day at 9:00 AM", next_run: null, updated_at: "2026-11-24T08:00:00.000Z", ...extra }) as unknown as InboxScheduledRow;
  const write = (route: string, body: Record<string, unknown> = {}): HeldRoutineWrite => ({ route, body, queued_at: "2026-11-24T09:00:00.000Z" });

  test("an edit (and its schedule's words), a turn off, a delete and a bring back show as the person made them, in order", () => {
    const rows = [full("sch_a"), full("sch_b"), full("sch_c")];
    const shown = withHeld(
      rows,
      [
        write("scheduled/sch_a", { name: "Evening digest", schedule: { cron: "0 18 * * *", tz: "UTC" }, idempotency_key: "k" }),
        write("scheduled/sch_b/off"),
        write("scheduled/sch_c/delete"),
        write("scheduled/sch_b/delete"),
        write("scheduled/sch_b/restore"),
        write("scheduled/sch_gone/off"),
      ],
      new Date("2026-11-24T10:00:00Z"),
    );
    expect(shown.map((r) => [r.id, r.name, r.state, r.enabled])).toEqual([
      ["sch_a", "Evening digest", "on", true],
      ["sch_b", "sch_b", "off", false],
    ]);
    expect(shown[0]!.schedule_words).not.toBe("Every day at 9:00 AM");
    expect(shown[0]!.updated_at).toBe("2026-11-24T09:00:00.000Z");
  });

  test("taken or refused there (no longer waiting): the row is as that computer said again", async () => {
    let held: HeldRoutineWrite[] = [write("scheduled/sch_1", { name: "Evening digest" })];
    const studio = peer("ibx_STUDIO", () => Response.json({ scheduled: [full("sch_1", { name: "Morning digest" })], launch_on: true }));
    const far = createFarRoutines(() => [studio], () => held);
    expect((await far.read())[0]!.rows.map((r) => r.name)).toEqual(["Evening digest"]);
    studio.state = "offline";
    expect((await far.read()).map((one) => [one.away, one.rows.map((r) => r.name)])).toEqual([[true, ["Evening digest"]]]);
    held = [];
    expect((await far.read())[0]!.rows.map((r) => r.name)).toEqual(["Morning digest"]);
  });
});

describe("the window's routes", () => {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fake = (rows: InboxScheduledRow[]) => {
    const turned: [string, boolean][] = [];
    const scheduled = {
      list: () => rows,
      rowOf: (record: unknown) => record,
      setOn: async (id: string, on: boolean) => (turned.push([id, on]), { record: { id, on } }),
    } as unknown as InboxScheduled;
    return { scheduled, turned };
  };
  const deps = (scheduled: InboxScheduled, on: boolean, extra: Partial<Parameters<typeof scheduledRoute>[2]> = {}) => ({
    scheduled,
    on: () => on,
    launchOn: () => true,
    serverSession: "srv_1",
    json,
    readBody: async (req: Request) => (await req.json()) as Record<string, unknown>,
    ...extra,
  });
  const far = async () => [{ machine: "ibx_STUDIO", on: true, launch_on: true, away: true, rows: [{ ...row("sch_far"), machine: "ibx_STUDIO" }] }];

  test("the merged read: this computer's and each linked one's, with which computers take them; this one's off: only theirs", async () => {
    const { scheduled } = fake([row("sch_here")]);
    const merged = await scheduledRoute(new Request("http://127.0.0.1/api/inbox/scheduled?machines=1"), "/api/inbox/scheduled", deps(scheduled, true, { far }));
    expect(await merged!.json()).toEqual({ scheduled: [row("sch_here"), { ...row("sch_far"), machine: "ibx_STUDIO" }], launch_on: true, computers: [{ id: "ibx_STUDIO", on: true, launch_on: true, away: true }] });
    const off = await scheduledRoute(new Request("http://127.0.0.1/api/inbox/scheduled?machines=1"), "/api/inbox/scheduled", deps(scheduled, false, { far }));
    expect(((await off!.json()) as { scheduled: { id: string }[] }).scheduled.map((r) => r.id)).toEqual(["sch_far"]);
    // Without machines=1 it is this computer's alone, and off is the off answer as ever.
    const own = await scheduledRoute(new Request("http://127.0.0.1/api/inbox/scheduled"), "/api/inbox/scheduled", deps(scheduled, false, { far }));
    expect(own!.status).toBe(404);
  });

  test("a press in a linked computer's window (the door's mark) changes a routine here; a bare call does not", async () => {
    const { scheduled, turned } = fake([]);
    const press = (farWindow: boolean) =>
      scheduledRoute(new Request("http://127.0.0.1/api/inbox/scheduled/sch_1/on", { method: "POST", body: JSON.stringify({ idempotency_key: "k" }) }), "/api/inbox/scheduled/sch_1/on", deps(scheduled, true, { farWindow: () => farWindow }));
    expect((await press(false))!.status).toBe(403);
    expect(turned).toEqual([]);
    expect((await press(true))!.status).toBe(200);
    expect(turned).toEqual([["sch_1", true]]);
  });
});

describe("the door and the forward", () => {
  const routes = ["scheduled", "scheduled/sch_01J", "scheduled/preview", "scheduled/sch_01J/on", "scheduled/sch_01J/off", "scheduled/sch_01J/run", "scheduled/sch_01J/stop", "scheduled/sch_01J/delete", "scheduled/sch_01J/restore", "capabilities"];

  test("a linked computer reaches every routine route and the switches; a phone none", () => {
    for (const route of routes) expect([route, doorRouteOf("POST", route, true)?.windowPath ?? null]).not.toEqual([route, null]);
    for (const route of routes) expect([route, doorRouteOf("POST", route, false)]).toEqual([route, null]);
    expect(doorRouteOf("GET", "scheduled", true)?.windowPath).toBe("/api/inbox/scheduled");
    expect(doorRouteOf("GET", "scheduled/sch_01J", true)?.windowPath).toBe("/api/inbox/scheduled/sch_01J");
    expect(doorRouteOf("GET", "capabilities", true)?.windowPath).toBe("/api/inbox/capabilities");
    expect(doorRouteOf("POST", "capabilities", true)?.windowPath).toBe("/api/inbox/settings");
    // An id that is not a routine's never reaches the window route.
    expect(doorRouteOf("GET", "scheduled/..", true)).toBeNull();
    expect(doorRouteOf("POST", "scheduled/x/run", true)).toBeNull();
  });

  // Which writes wait for an away computer and which are now or not at all: inbox-scheduled-forward.test.ts, through the real forward.
  test("a routine's write is a window's press only", () => {
    for (const route of routes.filter((r) => r !== "scheduled/preview" && r !== "capabilities")) expect([route, startsAgentThere(route, {})]).toEqual([route, true]);
    expect(startsAgentThere("scheduled/preview", {})).toBe(false);
    expect(startsAgentThere("capabilities", {})).toBe(false);
  });
});
