/**
 * The reveals' queue (approval "inbox-feature-reveal", 2026-11-03), by a clock the test moves. What regresses: the
 * order (Snooze, then the Board); the one-day spacing moving or letting two through; a stuck Snooze holding the Board
 * back for ever, or patience skipping an entry with nothing behind it; the Board's tenure (3 days, the owner's
 * change) or its 5 threads moving; a dev build or a feature the person decided being revealed; the Checklist (approval
 * "inbox-checklist-reveal", 2026-11-04) leaving its place after Snooze and the Board, its 5 days or 5 threads moving, or
 * it needing the Board on; the "Star the repo" ask (approval "star-ask", 2026-11-06) showing on the first day of Inbox
 * use, waiting for more days or a number of threads (the owner: "2nd day of inbox use"), becoming `next` (so passing or
 * being passed by an offer), or showing while the line is not free.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_REVEALS, REVEAL_PATIENCE_MS, REVEAL_SPACING_MS, revealAsideNow, revealLastShown, revealMayClaim, revealNext, type RevealState } from "./reveals";

const MINUTE = 60_000;
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
    // Code review's day-0 offer (approval "code-review-offer-card"), the update-day dialogs (approval
    // "inbox-one-time-dialogs"), then the offers.
    expect(INBOX_REVEALS.map((entry) => entry.id)).toEqual(["code_review", "sound", "list_intro", "voice", "tab_icon", "theme_chooser", "snooze", "bro", "board", "steps", "grill_me_tip", "star", "list_view"]);
    expect(revealNext(state(), NOW)).toBe("snooze");
    expect(revealNext(state({ open: { snooze: false, board: true } }), NOW)).toBe("board");
    expect(revealNext(state({ open: { snooze: false, board: false } }), NOW)).toBeNull();
  });

  test("a claim for anything but next is refused (a tab that armed something else)", () => {
    expect(revealMayClaim("snooze", state(), NOW)).toBe(true);
    expect(revealMayClaim("board", state(), NOW)).toBe(false);
    expect(revealMayClaim("board", state({ open: { board: true } }), NOW)).toBe(true);
  });

  test("the Checklist comes after Snooze and the Board: last in line while either is still open", () => {
    const day6 = { firstUseAt: ago(6 * DAY) };
    expect(revealNext(state({ ...day6, open: { snooze: true, board: true, steps: true } }), NOW)).toBe("snooze");
    expect(revealNext(state({ ...day6, open: { snooze: false, board: true, steps: true } }), NOW)).toBe("board");
    expect(revealNext(state({ ...day6, open: { snooze: false, board: false, steps: true } }), NOW)).toBe("steps");
    // A tab that armed the Checklist while the Board is next is refused.
    expect(revealMayClaim("steps", state({ ...day6, open: { board: true, steps: true } }), NOW)).toBe(false);
    expect(revealMayClaim("steps", state({ ...day6, open: { steps: true } }), NOW)).toBe(true);
  });

  test("the Checklist keeps the 40-minute gap after the Board", () => {
    const after = (ms: number) => revealNext(state({ firstUseAt: ago(6 * DAY), lastShownAt: ago(ms), open: { steps: true } }), NOW);
    expect(after(40 * MINUTE - 1)).toBeNull();
    expect(after(40 * MINUTE)).toBe("steps");
  });

  test("the list dialog waits for five threads, fresh installs included (no day count); below that the line passes it", () => {
    // Approval "inbox-rows-dialog", round 7b (q-2c590791): 5+ threads, no day-four rule.
    const list = (threads: number, firstUseAt: string | null = ago(4 * DAY)) => revealNext(state({ threads, firstUseAt, open: { list_intro: true, voice: true } }), NOW);
    expect(list(4)).toBe("voice");
    expect(list(5)).toBe("list_intro");
    expect(list(5, null)).toBe("list_intro");
    expect(list(5, ago(HOUR))).toBe("list_intro");
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

describe("the Checklist's who", () => {
  const steps = (over: Partial<RevealState>) => revealNext(state({ firstUseAt: ago(5 * DAY), open: { steps: true }, ...over }), NOW);

  test("tenure: exactly 5 days of first use, not a millisecond before", () => {
    expect(INBOX_REVEALS.find((entry) => entry.id === "steps")).toMatchObject({ tenureMs: 5 * DAY, minThreads: 5, enabled: true });
    expect(steps({ firstUseAt: ago(5 * DAY) })).toBe("steps");
    expect(steps({ firstUseAt: ago(5 * DAY - 1) })).toBeNull();
  });

  test("threads: 5 or more", () => {
    expect(steps({ threads: 5 })).toBe("steps");
    expect(steps({ threads: 4 })).toBeNull();
  });

  test("the Board need not be on: a Board switched off (no longer open) leaves the Checklist next", () => {
    expect(steps({ open: { board: false, steps: true } })).toBe("steps");
  });

  test("a Checklist the person decided (not open), or a dev build, is never next", () => {
    expect(steps({ open: { steps: false } })).toBeNull();
    expect(steps({ release: false })).toBeNull();
  });
});

describe("the spacing", () => {
  test("never within 40 minutes of the last dialog, open again at exactly 40 (the owner, 2026-11-09: no whole day), whatever the calendar day", () => {
    expect(REVEAL_SPACING_MS).toBe(40 * MINUTE);
    expect(revealNext(state({ lastShownAt: ago(40 * MINUTE - 1) }), NOW)).toBeNull();
    expect(revealNext(state({ lastShownAt: ago(40 * MINUTE) }), NOW)).toBe("snooze");
    // A claim checks it too.
    expect(revealMayClaim("snooze", state({ lastShownAt: ago(20 * MINUTE) }), NOW)).toBe(false);
    expect(revealMayClaim("snooze", state({ lastShownAt: ago(HOUR) }), NOW)).toBe(true);
    // The same day is no bar any more: a dialog an hour ago, the agent note included (it stamps only `dayShownAt`).
    expect(revealNext(state({ lastShownAt: ago(HOUR), dayShownAt: ago(HOUR) }), NOW)).toBe("snooze");
    expect(revealNext(state({ dayShownAt: ago(40 * MINUTE - 1) }), NOW)).toBeNull();
    // A card that stands aside (the star ask, the grill-me tip) starts the gap too, so nothing stacks on it.
    expect(revealNext(state({ asideShownAt: ago(40 * MINUTE - 1) }), NOW)).toBeNull();
    expect(revealNext(state({ asideShownAt: ago(40 * MINUTE) }), NOW)).toBe("snooze");
    // So does a tip outside the line (the Sidebar tip, the Launch tip): a dialog follows it 40 minutes later at the earliest.
    expect(revealNext(state({ tipShownAt: ago(40 * MINUTE - 1) }), NOW)).toBeNull();
    expect(revealMayClaim("snooze", state({ tipShownAt: ago(40 * MINUTE - 1) }), NOW)).toBe(false);
    expect(revealNext(state({ tipShownAt: ago(40 * MINUTE) }), NOW)).toBe("snooze");
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
    expect(revealNext(state({ waitingSince: { snooze: ago(6 * DAY) }, open: { snooze: true, board: false }, lastShownAt: ago(24 * HOUR) }), NOW)).toBe("snooze");
  });

  test("both past patience: the one that has waited longest goes, so the Board never replaces Snooze for good", () => {
    expect(revealNext(state({ waitingSince: { snooze: ago(10 * DAY), board: ago(7 * DAY) } }), NOW)).toBe("snooze");
    expect(revealNext(state({ waitingSince: { snooze: ago(7 * DAY), board: ago(10 * DAY) } }), NOW)).toBe("board");
  });

  test("passed over only for an entry that qualifies: a stuck Snooze with under 5 threads stays next", () => {
    expect(revealNext(state({ threads: 4, waitingSince: { snooze: ago(10 * DAY) } }), NOW)).toBe("snooze");
  });
});

describe("the star ask's who (approval \"star-ask\")", () => {
  // Local calendar days, as the line counts them: NOW's own day, at 00:30 and 23:30.
  const local = (dayOffset: number, h: number, m: number) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const at = local(0, 0, 30);
  const star = (over: Partial<RevealState>, now: Date = at) =>
    revealMayClaim("star", state({ firstUseAt: local(-1, 23, 30).toISOString(), threads: 0, open: { star: true }, ...over }), now) ? "star" : null;

  test("outside the line's order: never next, never in the way of an offer, claimable beside whichever offer is next", () => {
    const week = { firstUseAt: ago(7 * DAY), threads: 10 };
    expect(revealNext(state({ ...week, open: { star: true } }), NOW)).toBeNull();
    expect(revealNext(state({ ...week, open: { steps: true, star: true } }), NOW)).toBe("steps");
    // A stuck Snooze past its patience is still the one that goes (the star ask never takes its turn).
    expect(revealNext(state({ ...week, open: { snooze: true, star: true }, waitingSince: { snooze: ago(5 * DAY) } }), NOW)).toBe("snooze");
    expect(revealMayClaim("star", state({ ...week, open: { steps: true, star: true } }), NOW)).toBe(true);
    expect(revealAsideNow(state({ ...week, open: { steps: true, star: true } }), NOW)).toEqual(["star"]);
  });

  test("only while the line is free: not within 40 minutes of a dialog, not after a Not now", () => {
    expect(star({ dayShownAt: local(0, 0, 5).toISOString() })).toBeNull();
    expect(star({ lastShownAt: local(0, 0, 0).toISOString() })).toBeNull();
    // 40 minutes on, the same day: free.
    expect(star({ lastShownAt: local(-1, 23, 50).toISOString(), dayShownAt: local(-1, 23, 50).toISOString() })).toBe("star");
    expect(star({ notNowAt: local(-2, 9, 0).toISOString() })).toBeNull();
  });

  test("from the second day of Inbox use (a later calendar day, not 24 hours), with no thread minimum", () => {
    // Day 1: first use an hour ago, the day before; no threads at all.
    expect(star({})).toBe("star");
    // Day 0: first use earlier the same day, even 23 hours earlier.
    expect(star({ firstUseAt: local(0, 0, 10).toISOString() })).toBeNull();
    expect(star({ firstUseAt: local(0, 0, 10).toISOString() }, local(0, 23, 10))).toBeNull();
    // The next day it goes.
    expect(star({ firstUseAt: local(0, 0, 10).toISOString() }, local(1, 0, 10))).toBe("star");
    // No first use known: never.
    expect(star({ firstUseAt: null })).toBeNull();
  });

  test("on day 1, beside offers not due yet (Snooze waits for day 2)", () => {
    expect(star({ open: { snooze: true, board: true, steps: true, star: true }, threads: 20 })).toBe("star");
  });

  test("closed once shown or answered on any surface (not open), or a dev build: never next", () => {
    expect(star({ open: { star: false } })).toBeNull();
    expect(star({ release: false })).toBeNull();
  });
});
