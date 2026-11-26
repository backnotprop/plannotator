/**
 * Merged ships across linked machines (inbox-machine-ships.ts). What regresses:
 *  - a PR shipped by an agent on a linked machine losing its Reviews row here at merge (the far ships never read, or
 *    read only as this machine's own);
 *  - the Reviews read waiting on another computer (a held read must not hold the answer);
 *  - a machine without the `ships` mark (an older one) asked anyway, or Code review off there still counted;
 *  - a far answer's ship taken as typed: one not merged, a link to another host, a number not its key's;
 *  - the read repeated on every Reviews read (a fresh read is reused).
 * Peers are stubs; no second Inbox, no network.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_SHIP_MERGED_SHOWN_MS, shipsMergedShown } from "@plannotator/core/inbox-pull-handoff";
import type { PeerLink } from "./inbox-peer-link";
import { createMachineShips, farMergedShip } from "./inbox-machine-ships";

const B = "ibx_01JD000000000000000000000B";
const C = "ibx_01JD000000000000000000000C";
const NOW = Date.parse("2026-11-24T18:00:00.000Z");

const far = (number: number, fields: Record<string, unknown> = {}) => ({
  id: `shp_${number}`,
  key: `github.com/harbor/fern-api#${number}`,
  url: `https://github.com/harbor/fern-api/pull/${number}`,
  title: `Change ${number}`,
  number,
  repo: "harbor/fern-api",
  host: "github.com",
  thread_id: "msg_01JD0000000000000000000000",
  project_id: "prj_on_b",
  state: "merged",
  reason: null,
  started_at: "2026-11-24T15:00:00.000Z",
  ended_at: "2026-11-24T17:00:00.000Z",
  merged_at: "2026-11-24T16:59:00.000Z",
  ...fields,
});

function peer(id: string, marks: string[], answer: () => Response | Promise<Response>, asked: string[]) {
  return {
    id,
    state: "online",
    list: { marks },
    request: async (route: string) => {
      asked.push(`${id} ${route}`);
      return answer();
    },
  } as unknown as PeerLink;
}

describe("a linked machine's merged ships", () => {
  test("only a taker is asked, only its merged ships are kept, and a fresh read is reused", async () => {
    const asked: string[] = [];
    let clock = NOW;
    const answer = () => Response.json({ ships: [far(614), far(615, { state: "shipping", ended_at: null, merged_at: null }), far(616, { url: "https://evil.example/harbor/fern-api/pull/616" }), far(617, { number: 9 }), far(618, { ended_at: "soon" })], projects: {} });
    const ships = createMachineShips({ now: () => clock, peers: () => [peer(B, ["ships"], answer, asked), peer(C, ["pulls"], answer, asked)] });
    ships.start();
    await ships.settled();
    const got = ships.start();
    // A shipping one is kept too (its PR may land before its ship is marked merged), never as merged.
    expect(got.map((ship) => [ship.key, ship.state])).toEqual([["github.com/harbor/fern-api#614", "merged"], ["github.com/harbor/fern-api#615", "shipping"]]);
    expect(asked).toEqual([`${B} ships`]);
    // What Reviews keeps by: this machine's own ships and the far ones, the far one's PR by its key.
    expect([...shipsMergedShown(got, NOW).keys()]).toEqual(["github.com/harbor/fern-api#614"]);
    expect(shipsMergedShown(got, NOW + INBOX_SHIP_MERGED_SHOWN_MS).size).toBe(0);
    clock = NOW + 60_000;
    ships.start();
    await ships.settled();
    expect(asked).toHaveLength(2);
  });

  test("a Reviews read never waits on the other computer: a held read answers what was last read", async () => {
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    const ships = createMachineShips({ now: () => NOW, peers: () => [peer(B, ["ships"], async () => (await held, Response.json({ ships: [far(614)] })), [])] });
    expect(ships.start()).toEqual([]);
    release();
    await ships.settled();
    expect(ships.start().map((ship) => ship.key)).toEqual(["github.com/harbor/fern-api#614"]);
  });

  test("another computer's clock never stretches or cuts the 6 hours: they run from this computer's first sight", async () => {
    const DAY = 24 * 3_600_000;
    let clock = NOW;
    let list = [far(1, { ended_at: new Date(NOW + DAY).toISOString() }), far(2, { ended_at: new Date(NOW - DAY).toISOString() }), far(2099, { ended_at: "2099-01-01T00:00:00.000Z" })];
    const ships = createMachineShips({ now: () => clock, peers: () => [peer(B, ["ships"], () => Response.json({ ships: list }), [])] });
    const shown = async (at: number) => {
      clock = at;
      ships.start();
      await ships.settled();
      return [...shipsMergedShown(ships.start(), at).keys()].map((key) => Number(key.split("#")[1]));
    };
    // Ended "tomorrow" and in 2099 by their clock, "yesterday" by its own: all three show now, first seen now.
    expect(await shown(NOW)).toEqual([1, 2, 2099]);
    expect(await shown(NOW + 5 * 3_600_000)).toEqual([1, 2, 2099]);
    // 7 hours after this computer first saw them: none, whatever the other clock says.
    expect(await shown(NOW + 7 * 3_600_000)).toEqual([]);
    // One first seen 7 hours in, though it ended long before by its own clock: shown from then.
    list = [...list, far(3, { ended_at: new Date(NOW - DAY).toISOString() })];
    expect(await shown(NOW + 7 * 3_600_000 + 60_000)).toEqual([3]);
  });

  test("Code review off there (409) counts none of its ships; a refusal or a failure keeps the last read", async () => {
    let status = 200;
    let clock = NOW;
    const ships = createMachineShips({ now: () => clock, peers: () => [peer(B, ["ships"], () => (status === 200 ? Response.json({ ships: [far(614)] }) : status === 0 ? Promise.reject(new Error("asleep")) : Response.json({ code: "x" }, { status })), [])] });
    ships.start();
    await ships.settled();
    for (const next of [404, 0]) {
      status = next;
      clock += 60_000;
      ships.start();
      await ships.settled();
      expect(ships.start()).toHaveLength(1);
    }
    status = 409;
    clock += 60_000;
    ships.start();
    await ships.settled();
    expect(ships.start()).toHaveLength(0);
  });

  test("farMergedShip keeps only what a landing needs", () => {
    expect(farMergedShip(far(614))).toEqual({ key: "github.com/harbor/fern-api#614", url: "https://github.com/harbor/fern-api/pull/614", number: 614, title: "Change 614", state: "merged", ended_at: "2026-11-24T17:00:00.000Z", merged_at: "2026-11-24T16:59:00.000Z" });
    expect(farMergedShip(far(614, { url: "http://github.com/harbor/fern-api/pull/614" }))).toBeNull();
    expect(farMergedShip(far(614, { key: "not a key" }))).toBeNull();
    expect(farMergedShip(null)).toBeNull();
  });
});
