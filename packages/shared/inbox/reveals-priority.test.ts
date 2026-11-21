/**
 * The Priority dialog in the line (reveals.ts `priority`; the owner, 2026-11-13: after tags and personal agents, "only
 * if users haven't used priority yet").
 *
 * What regresses: its place (right after personal agents and before the Board; a tags entry added after Snooze comes
 * before both); its 3 days of use or its 8 threads moving; it being due once the person used Priority (the
 * server's `open`); Escape (its Not now) not holding the next offer three days.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REVEALS, REVEAL_NOT_NOW_SPACING_MS, revealNext, revealNotNowAllowed, type RevealEntry, type RevealState } from "./reveals";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-13T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const state = (over: Partial<RevealState> = {}): RevealState => ({ release: true, firstUseAt: ago(4 * DAY), threads: 8, open: { priority: true }, waitingSince: {}, ...over });

describe("its place in the line", () => {
  test("after Snooze and before the Board: Snooze goes first, then Priority, then the Board", () => {
    const ids = INBOX_REVEALS.map((entry) => entry.id);
    expect(ids.indexOf("priority")).toBeGreaterThan(ids.indexOf("snooze"));
    expect(ids.indexOf("priority")).toBe(ids.indexOf("board") - 1);
    expect(revealNext(state({ open: { snooze: true, priority: true, board: true } }), NOW)).toBe("snooze");
    expect(revealNext(state({ open: { priority: true, board: true } }), NOW)).toBe("priority");
    expect(revealNext(state({ open: { priority: false, board: true } }), NOW)).toBe("board");
  });

  test("right after personal agents, so personal agents goes first; a tags entry added after Snooze goes before both", () => {
    const ids = INBOX_REVEALS.map((entry) => entry.id);
    expect(ids.indexOf("priority")).toBe(ids.indexOf("personal_agents") + 1);
    expect(revealNext(state({ open: { personal_agents: true, priority: true } }), NOW)).toBe("personal_agents");
    const tags = { id: "tags", kind: "offer", tenureMs: 2 * DAY, minThreads: 0, enabled: true } as unknown as RevealEntry;
    const table = [...INBOX_REVEALS];
    table.splice(table.findIndex((entry) => entry.id === "snooze") + 1, 0, tags);
    const open = { priority: true, tags: true, personal_agents: true } as RevealState["open"];
    expect(revealNext(state({ open }), NOW, table)).toBe("tags" as never);
    expect(revealNext(state({ open: { ...open, tags: false } as RevealState["open"] }), NOW, table)).toBe("personal_agents");
    expect(revealNext(state({ open: { ...open, tags: false, personal_agents: false } as RevealState["open"] }), NOW, table)).toBe("priority");
  });
});

describe("who", () => {
  test("from three days of use, not before", () => {
    expect(revealNext(state({ firstUseAt: ago(3 * DAY - 1) }), NOW)).toBeNull();
    expect(revealNext(state({ firstUseAt: ago(3 * DAY) }), NOW)).toBe("priority");
    expect(revealNext(state({ firstUseAt: null }), NOW)).toBeNull();
  });

  test("from eight threads, not fewer", () => {
    expect(revealNext(state({ threads: 7 }), NOW)).toBeNull();
    expect(revealNext(state({ threads: 8 }), NOW)).toBe("priority");
  });

  test("never once the person used Priority (the server reports it closed), whatever else holds", () => {
    expect(revealNext(state({ firstUseAt: ago(30 * DAY), threads: 80, open: { priority: false } }), NOW)).toBeNull();
  });

  test("never on a dev build", () => {
    expect(revealNext(state({ release: false }), NOW)).toBeNull();
  });

  test("Escape is a Not now: the next offer waits three days", () => {
    expect(revealNotNowAllowed("priority")).toBe(true);
    expect(revealNext(state({ open: { board: true }, notNowAt: ago(REVEAL_NOT_NOW_SPACING_MS - 1) }), NOW)).toBeNull();
    expect(revealNext(state({ open: { board: true }, notNowAt: ago(REVEAL_NOT_NOW_SPACING_MS) }), NOW)).toBe("board");
  });
});
