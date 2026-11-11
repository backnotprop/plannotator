/**
 * The list feed's applier: a window that starts from a first page and applies every frame it gets (catching up
 * after a missed frame, merging pages that answered late) ends up holding exactly the list a fresh read gives. The
 * failures this guards: a row lost or duplicated, a stale row winning over a newer one, an island of rows below the
 * loaded edge, a pinned row missing, or an order that differs from today's sections.
 */
import { describe, expect, test } from "bun:test";
import { feedRow, feedScenario, feedServer } from "./inbox-list-feed-fixtures";
import {
  applyInboxListCatchUp,
  applyInboxListFrame,
  inboxListHeld,
  inboxListShown,
  inboxPlaceCompare,
  inboxRowPlace,
  mergeInboxListPage,
  type InboxListHeld,
} from "./inbox-list-feed";
import type { InboxListRow, InboxSectionId } from "./inbox-types";
import { inboxSplitSnoozed } from "./inbox-snooze";

const shown = (held: InboxListHeld) => inboxListShown(held).map(({ row, place }) => ({ row, place }));

/** Every page after the held edge, merged (what scrolling to the end does). */
function loadAll(held: InboxListHeld, server: ReturnType<typeof feedServer>): InboxListHeld {
  let out = held;
  for (let guard = 0; out.next !== null && guard < 100; guard++) out = mergeInboxListPage(out, server.page({ after: out.next, limit: 7 })).held;
  return out;
}

describe("the list feed", () => {
  test("the worked scenario: a row past the edge that moves up joins, an archived one leaves, one that stays past the edge is not taken", () => {
    const { server, first, frames, deep, archived, unchanged } = feedScenario();
    let held = inboxListHeld(first);
    expect(held.rows[deep]).toBeUndefined();
    expect(held.rows[unchanged]).toBeUndefined();
    for (const frame of frames) {
      const next = applyInboxListFrame(held, frame);
      if (next === "gap") throw new Error("gap");
      held = next;
    }
    expect(held.rows[deep]?.place.group).toBe("new");
    expect(held.rows[archived]).toBeUndefined();
    expect(held.rows[unchanged]).toBeUndefined();
    expect(held.counts).toEqual(frames.at(-1)!.counts);
    expect(held.counts.groups).toEqual({ waiting: 3, new: 1, quiet: 298 });
    expect(shown(loadAll(held, server))).toEqual(shown(loadAll(inboxListHeld(server.page()), server)));
  });

  test("a missed frame is a gap; a frame already held changes nothing", () => {
    const server = feedServer();
    server.change([feedRow(1)]);
    const held = inboxListHeld(server.page());
    const one = server.change([feedRow(2)]);
    const two = server.change([feedRow(3)]);
    expect(applyInboxListFrame(held, two)).toBe("gap");
    const after = applyInboxListFrame(held, one);
    if (after === "gap") throw new Error("gap");
    expect(applyInboxListFrame(after, one)).toBe(after);
    // A frame from another run (the Inbox restarted) is a gap too.
    expect(applyInboxListFrame(after, { ...two, version: "ffff.1", after: "ffff.0" })).toBe("gap");
  });

  test("the order is today's: sections newest first with ties A→Z, the Snoozed band soonest first", () => {
    const now = new Date("2026-11-02T00:00:00.000Z");
    const same = "2026-11-01T10:00:00.000Z";
    const rows: InboxListRow[] = [
      feedRow(3, { last_at: same }),
      feedRow(1, { last_at: same }),
      feedRow(2, { last_at: "2026-11-01T11:00:00.000Z" }),
      feedRow(5, { snoozed: { until: "2026-11-03T00:00:00.000Z", at: same } }),
      feedRow(4, { snoozed: { until: "2026-11-02T12:00:00.000Z", at: same } }),
    ];
    const placed = rows.map((row) => ({ row, place: inboxRowPlace(row, now) })).sort(inboxPlaceCompare);
    const split = inboxSplitSnoozed(rows, now);
    const today = [...split.rows.sort((a, b) => b.last_at.localeCompare(a.last_at) || a.thread_id.localeCompare(b.thread_id)), ...split.snoozed];
    expect(placed.map((p) => p.row.thread_id)).toEqual(today.map((row) => row.thread_id));
  });

  test("any run of changes, missed frames and late pages ends at what a fresh read gives", () => {
    const sections: InboxSectionId[] = ["stopped", "waiting", "new", "sent", "quiet", "quiet", "quiet", "quiet"];
    const idOf = (n: number) => `msg_${String(n).padStart(26, "0")}`;
    // 400 seeded runs (mulberry32): a failing seed is printed and can be run again.
    for (let seed = 1; seed <= 400; seed++) {
      let a = seed >>> 0;
      const random = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
      const now = new Date("2026-11-02T00:00:00.000Z");
      const limit = int(1, 12);
      const server = feedServer({ now });
      server.change(Array.from({ length: 40 }, (_, i) => feedRow(i + 1, { section: sections[i % sections.length] })));
      let held = inboxListHeld(server.page({ limit }));
      let dropping = false;
      let late: ReturnType<typeof server.page> | null = null;
      const take = (frame: ReturnType<typeof server.change>) => {
        if (dropping) return;
        const next = applyInboxListFrame(held, frame);
        held = next === "gap" ? applyInboxListCatchUp(held, server.catchUp(held.version)) : next;
      };
      const answerLate = () => {
        if (!late) return;
        const merged = mergeInboxListPage(held, late);
        held = merged.catchUpFrom ? applyInboxListCatchUp(merged.held, server.catchUp(merged.catchUpFrom)) : merged.held;
        late = null;
      };
      for (let step = int(1, 60); step > 0; step--) {
        const roll = random();
        if (roll < 0.55) {
          const section = sections[int(0, sections.length - 1)]!;
          const at = new Date(Date.UTC(2026, 10, 1) + int(0, 2000) * 60_000).toISOString();
          const hours = int(-2, 6);
          const snoozed = hours === 0 || random() < 0.6 ? null : { until: new Date(now.getTime() + hours * 3_600_000).toISOString(), at };
          take(server.change([feedRow(int(1, 60), { section, last_at: at, unseen: section === "new" ? 1 : 0, unread: section !== "quiet", resolved_at: random() < 0.15 ? at : null, snoozed })]));
        } else if (roll < 0.65) take(server.change([{ gone: idOf(int(1, 60)) }]));
        else if (roll < 0.72) take(server.change([], Array.from({ length: int(0, 4) }, () => idOf(int(1, 60)))));
        else if (roll < 0.8) {
          // The connection drops, or comes back: a window that reconnects reads what it missed.
          dropping = !dropping;
          if (!dropping) held = applyInboxListCatchUp(held, server.catchUp(held.version));
        }
        else if (held.next !== null) {
          // A page read now; answered now, or after the next steps.
          answerLate();
          const page = server.page({ after: held.next, limit });
          if (random() < 0.5) late = page;
          else held = mergeInboxListPage(held, page).held;
        }
      }
      if (dropping) held = applyInboxListCatchUp(held, server.catchUp(held.version));
      answerLate();
      const fresh = loadAll(inboxListHeld(server.page({ limit })), server);
      const label = { seed };
      expect({ ...label, rows: shown(loadAll(held, server)) }).toEqual({ ...label, rows: shown(fresh) });
      expect({ ...label, counts: held.counts, pins: held.pins }).toEqual({ ...label, counts: fresh.counts, pins: fresh.pins });
      // Every pinned row is held, wherever it sits.
      for (const id of held.pins) expect({ ...label, id, held: held.rows[id] !== undefined }).toEqual({ ...label, id, held: true });
    }
  });
});
