/**
 * The reveals' queue (approval "inbox-feature-reveal", 2026-11-03), by a clock the test moves. What regresses: the
 * order (Snooze, then the Board); the 48 h spacing moving or letting two through; a stuck Snooze holding the Board
 * back for ever, or patience skipping an entry with nothing behind it; the Board's tenure (3 days, the owner's
 * change) or its 5 threads moving; a dev build, a feature the person decided, or the steps placeholder being revealed.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REVEALS, REVEAL_PATIENCE_MS, REVEAL_SPACING_MS, revealLastShown, revealMayClaim, revealNext, type RevealState } from "./inbox-reveals";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-07T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/** Day 4, six threads, Snooze and the Board both open, nothing shown yet. */
function state(over: Partial<RevealState> = {}): RevealState {
  return { release: true, firstUseAt: ago(4 * DAY), lastShownAt: null, threads: 6, open: { snooze: true, board: true }, waitingSince: {}, ...over };
}

describe("the order", () => {
  test("Snooze first, then the Board once Snooze is no longer open; nothing once both are spent", () => {
    expect(INBOX_REVEALS.map((entry) => entry.id)).toEqual(["snooze", "board", "steps"]);
    expect(revealNext(state(), NOW)).toBe("snooze");
    expect(revealNext(state({ open: { snooze: false, board: true } }), NOW)).toBe("board");
    expect(revealNext(state({ open: { snooze: false, board: false } }), NOW)).toBeNull();
  });

  test("a claim for anything but next is refused (a tab that armed something else)", () => {
    expect(revealMayClaim("snooze", state(), NOW)).toBe(true);
    expect(revealMayClaim("board", state(), NOW)).toBe(false);
    expect(revealMayClaim("board", state({ open: { board: true } }), NOW)).toBe(true);
  });

  test("the steps placeholder is never next, whatever its state", () => {
    expect(revealNext(state({ firstUseAt: ago(30 * DAY), open: { steps: true } }), NOW)).toBeNull();
    expect(revealMayClaim("steps", state({ firstUseAt: ago(30 * DAY), open: { steps: true } }), NOW)).toBe(false);
  });

  test("a dev build, or no first use known, decides nothing", () => {
    expect(revealNext(state({ release: false }), NOW)).toBeNull();
    expect(revealNext(state({ firstUseAt: null }), NOW)).toBeNull();
  });
});

describe("the Board's who", () => {
  const board = (over: Partial<RevealState>) => revealNext(state({ open: { board: true }, ...over }), NOW);

  test("tenure: exactly 3 days of first use, not a millisecond before", () => {
    expect(board({ firstUseAt: ago(3 * DAY) })).toBe("board");
    expect(board({ firstUseAt: ago(3 * DAY - 1) })).toBeNull();
  });

  test("threads: 5 or more", () => {
    expect(board({ threads: 5 })).toBe("board");
    expect(board({ threads: 4 })).toBeNull();
  });

  test("Snooze keeps its own 2 days and needs no threads", () => {
    expect(revealNext(state({ firstUseAt: ago(2 * DAY), threads: 0, open: { snooze: true } }), NOW)).toBe("snooze");
    expect(revealNext(state({ firstUseAt: ago(2 * DAY - 1), threads: 0, open: { snooze: true } }), NOW)).toBeNull();
  });
});

describe("the spacing", () => {
  test("never within 48 h of the last announcement: open again at exactly 48 h", () => {
    expect(REVEAL_SPACING_MS).toBe(48 * HOUR);
    expect(revealNext(state({ lastShownAt: ago(48 * HOUR - 1) }), NOW)).toBeNull();
    expect(revealNext(state({ lastShownAt: ago(48 * HOUR) }), NOW)).toBe("snooze");
    // A claim checks it too.
    expect(revealMayClaim("snooze", state({ lastShownAt: ago(HOUR) }), NOW)).toBe(false);
  });

  test("the clock is the latest stamp of any announcement, whatever key it is in", () => {
    expect(revealLastShown([undefined, ago(3 * DAY), ago(HOUR), null, ago(2 * DAY)])).toBe(ago(HOUR));
    expect(revealLastShown([undefined, null, "not a time"])).toBeNull();
  });
});

describe("the patience", () => {
  test("a Snooze next for 3 days without its moment lets the Board go first, and is next again after it", () => {
    expect(REVEAL_PATIENCE_MS).toBe(3 * DAY);
    expect(revealNext(state({ waitingSince: { snooze: ago(3 * DAY - 1) } }), NOW)).toBe("snooze");
    expect(revealNext(state({ waitingSince: { snooze: ago(3 * DAY) } }), NOW)).toBe("board");
    // The Board shown (no longer open) and spaced: Snooze is still in line, and nothing is behind it.
    expect(revealNext(state({ waitingSince: { snooze: ago(6 * DAY) }, open: { snooze: true, board: false }, lastShownAt: ago(48 * HOUR) }), NOW)).toBe("snooze");
  });

  test("both past patience: the one that has waited longest goes, so the Board never replaces Snooze for good", () => {
    expect(revealNext(state({ waitingSince: { snooze: ago(10 * DAY), board: ago(7 * DAY) } }), NOW)).toBe("snooze");
    expect(revealNext(state({ waitingSince: { snooze: ago(7 * DAY), board: ago(10 * DAY) } }), NOW)).toBe("board");
  });

  test("passed over only for an entry that qualifies: a stuck Snooze with under 5 threads stays next", () => {
    expect(revealNext(state({ threads: 4, waitingSince: { snooze: ago(10 * DAY) } }), NOW)).toBe("snooze");
  });
});
