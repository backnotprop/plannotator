/**
 * The schedule of the Inbox's one-time dialogs (approval "inbox-one-time-dialogs", 2026-11-06,
 * `.product/approved/inbox-one-time-dialogs/timeline-inbox.html`), by a clock the test moves over 30 days.
 *
 * A machine keeps what config.json keeps for the line (`inboxReveals`) and changes it only through the module's own
 * helpers, as packages/server/inbox.ts does: a page load is seen (`revealSeeLoad`), the page arms `revealNext`, the
 * agent note asks `revealLineFree("setup")`, a claim stamps (`revealStamp`), a Not now stamps (`revealStampNotNow`).
 * Each user brings their own loads, reads and moments (what the page would see). Bro mode and List view are not built
 * here: they are registered in a test table the way their branches register (`heavyUse`, `minThreads`), so the line's
 * seam is what is tested.
 *
 * What regresses: a heavy user's dialogs leaving their approved days (setup on day 0, then days 2, 4, 6, 8, 10); a
 * light user getting a heavy-use dialog; two dialogs on one day, or on two page loads in a row; the gap after Not
 * now; an offer whose moment never comes not retiring after 14 days; update-day dialogs coming back to back.
 */
import { describe, expect, test } from "bun:test";
import {
  INBOX_REVEALS,
  REVEAL_RETIRE_MS,
  revealAfterShowLoad,
  revealDay,
  revealHeavyUse,
  revealLineFree,
  revealMayClaim,
  revealNext,
  revealSeeLoad,
  revealStamp,
  revealStampNotNow,
  type RevealEntry,
  type RevealId,
  type RevealState,
  type RevealLoads,
  type RevealsSaved,
} from "./reveals";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Day 0, local time: the person's first use (or the update) is that morning. */
const at = (day: number, hour: number) => new Date(2026, 10, 2 + day, hour, 0, 0, 0);

const BRO = "bro" as RevealId;
const LIST_VIEW = "list_view" as RevealId;
/** The queue with Bro mode and List view registered at their places, as #2693 and #2716 add them. */
const TABLE: readonly RevealEntry[] = [
  ...INBOX_REVEALS.slice(0, 4),
  { id: BRO, kind: "offer", tenureMs: 2 * DAY, minThreads: 0, heavyUse: true, enabled: true },
  ...INBOX_REVEALS.slice(4),
  { id: LIST_VIEW, kind: "offer", tenureMs: 2 * DAY, minThreads: 15, enabled: true },
];

type Dialog = RevealId | "agent_note";

interface User {
  /** Days before day 0 the person first used the Inbox (0: day 0 is their first day). */
  usedSinceDays: number;
  /** An update on day 0 brought the update-day dialogs (sound, list options, voice). */
  update: boolean;
  /** The offers this person already saw before day 0. */
  seen?: readonly RevealId[];
  /** The hours of the day this person opens the Inbox, or none that day. */
  loads: (day: number) => readonly number[];
  /** Threads on the machine that day. */
  threads: (day: number) => number;
  /** Threads read at each load. */
  readsPerLoad: number;
  /** The page sees this dialog's moment (and its page-side need) on this load. */
  moment: (id: RevealId, day: number) => boolean;
  /** The dialogs this person closes with Not now. */
  notNow?: readonly RevealId[];
}

interface Shown {
  id: Dialog;
  day: number;
  at: Date;
}

/** 30 days of one person: every dialog shown, in order. */
function simulate(user: User, days = 30): Shown[] {
  let saved: RevealsSaved = user.update ? { lastShownAt: at(-20, 10).toISOString() } : {};
  const firstUseAt = at(-user.usedSinceDays, user.loads(0)[0] ?? 9).toISOString();
  const shown: Shown[] = [];
  const done = new Set<Dialog>(user.seen ?? []);
  const reads: { threadId: string; at: string }[] = [];
  let readCount = 0;
  let loadCount = 0;
  let loads: RevealLoads = {};
  for (let day = 0; day < days; day++) {
    for (const hour of user.loads(day)) {
      const now = at(day, hour);
      const load = `load-${String(++loadCount).padStart(4, "0")}`;
      loads = revealSeeLoad(loads, load) ?? loads;
      for (let i = 0; i < user.readsPerLoad; i++) reads.push({ threadId: `t${readCount++ % Math.max(1, user.threads(day))}`, at: now.toISOString() });
      const state = (): RevealState => ({
        release: true,
        firstUseAt,
        lastShownAt: saved.lastShownAt ?? null,
        dayShownAt: saved.dayShownAt ?? null,
        notNowAt: saved.notNowAt ?? null,
        afterShowLoad: revealAfterShowLoad(saved.shownLoad, loads, load),
        heavy: revealHeavyUse(reads, now),
        threads: user.threads(day),
        open: Object.fromEntries(TABLE.map((entry) => [entry.id, !done.has(entry.id) && (entry.kind === "offer" || user.update)])),
        waitingSince: saved.waitingSince,
      });
      const show = (id: Dialog, spaced: boolean) => {
        saved = revealStamp(saved, now.toISOString(), { spaced, load });
        if (id !== "agent_note" && user.notNow?.includes(id)) saved = revealStampNotNow(saved, now.toISOString());
        done.add(id);
        shown.push({ id, day, at: now });
      };
      // The page: the sound first (it opens at load), then the agent note (an agent with no note: on day 0 for
      // everyone, after the tour screen), then whatever the line has next, at its moment.
      const next = revealNext(state(), now, TABLE);
      if (next && !saved.waitingSince?.[next]) saved = { ...saved, waitingSince: { ...saved.waitingSince, [next]: now.toISOString() } };
      if (next === "sound") {
        show("sound", true);
        continue;
      }
      if (!done.has("agent_note") && revealLineFree("setup", state(), now)) {
        show("agent_note", false);
        continue;
      }
      if (next && user.moment(next, day) && revealMayClaim(next, state(), now, TABLE)) show(next, true);
    }
  }
  return shown;
}

const days = (shown: Shown[]) => Object.fromEntries(shown.map((s) => [s.id, s.day]));

/** Ten or more threads a day, five visits a day; every moment comes as soon as it can. */
const HEAVY: User = {
  usedSinceDays: 0,
  update: false,
  loads: () => [9, 11, 13, 15, 17],
  threads: (day) => 20 * (day + 1),
  readsPerLoad: 4,
  // Snooze needs two threads read and left for a day: from day 1.
  moment: (id, day) => id !== "snooze" || day >= 1,
};

/** A few threads a week, a visit every two or three days, one project. */
const LIGHT: User = {
  usedSinceDays: 0,
  update: false,
  loads: (day) => ([0, 2, 4, 7, 9, 11, 14, 16, 18, 21, 23, 25, 28].includes(day) ? [10] : []),
  threads: (day) => 1 + Math.floor(day / 2),
  readsPerLoad: 1,
  moment: (id, day) => {
    // Two threads left waiting a day: about day 7. A long agent run: only late. One project: never the Board's.
    if (id === "snooze") return day >= 7;
    if (id === "steps") return day >= 20;
    if (id === "board" || id === LIST_VIEW) return false;
    return true;
  },
};

/** Someone who used the Inbox for weeks updates on day 0 (a Codex user): Snooze, the Board and the Checklist seen. */
const UPGRADER: User = { ...HEAVY, usedSinceDays: 40, update: true, seen: ["snooze", "board", "steps"] };

function expectOnePerDay(shown: Shown[]) {
  const perDay = new Map<string, number>();
  for (const s of shown) perDay.set(revealDay(s.at.getTime()), (perDay.get(revealDay(s.at.getTime())) ?? 0) + 1);
  expect([...perDay.values()].every((n) => n === 1)).toBe(true);
}

describe("30 days of a heavy user", () => {
  test("setup on day 0, then Snooze, Bro mode, the Board, the Checklist and List view on days 2, 4, 6, 8 and 10; nothing new after", () => {
    const shown = simulate(HEAVY);
    expect(shown.map((s) => [s.id, s.day])).toEqual([
      ["agent_note", 0],
      ["snooze", 2],
      [BRO, 4],
      ["board", 6],
      ["steps", 8],
      [LIST_VIEW, 10],
    ]);
    expectOnePerDay(shown);
  });

  test("a Not now on Bro mode: the next offer waits four days, not two", () => {
    const shown = simulate({ ...HEAVY, notNow: [BRO] });
    expect(days(shown)).toEqual({ agent_note: 0, snooze: 2, [BRO]: 4, board: 8, steps: 10, [LIST_VIEW]: 12 });
  });
});

describe("30 days of a light user", () => {
  test("setup on day 0, Snooze about day 7, the Checklist late; never Bro mode, the Board or List view", () => {
    const shown = simulate(LIGHT);
    const got = days(shown);
    expect(got.agent_note).toBe(0);
    expect(got.snooze).toBe(7);
    expect(got.steps).toBeGreaterThanOrEqual(20);
    for (const never of [BRO, "board", LIST_VIEW]) expect(got[never]).toBeUndefined();
    expectOnePerDay(shown);
  });

  test("heavy use is never true for them: Bro mode stays out of the line, whatever its moment", () => {
    const reads = [0, 2, 4].flatMap((day) => [{ threadId: `t${day}`, at: at(day, 10).toISOString() }]);
    expect(revealHeavyUse(reads, at(5, 10))).toBe(false);
  });
});

describe("an update day", () => {
  test("the sound on the update day, the agent note the day after, list options on day 2, voice on day 4: never back to back", () => {
    const shown = simulate(UPGRADER);
    expect(shown.map((s) => [s.id, s.day])).toEqual([
      ["sound", 0],
      ["agent_note", 1],
      ["list_intro", 2],
      ["voice", 4],
      [BRO, 6],
      [LIST_VIEW, 8],
    ]);
    expectOnePerDay(shown);
  });
});

describe("the line's rules", () => {
  const NOW = at(10, 12);
  const base = (over: Partial<RevealState> = {}): RevealState => ({
    release: true,
    firstUseAt: at(0, 9).toISOString(),
    lastShownAt: null,
    threads: 30,
    open: { board: true, steps: true },
    waitingSince: {},
    ...over,
  });

  test("no two in one day: the agent note this morning holds every offer back until tomorrow, and itself shows once a day", () => {
    const morning = at(10, 8).toISOString();
    expect(revealNext(base({ dayShownAt: morning }), NOW)).toBeNull();
    expect(revealLineFree("setup", base({ dayShownAt: morning }), NOW)).toBe(false);
    // An offer yesterday evening: the agent note may show today, the next offer waits out its two days.
    const yesterday = at(9, 21).toISOString();
    expect(revealLineFree("setup", base({ lastShownAt: yesterday, dayShownAt: yesterday }), NOW)).toBe(true);
    expect(revealNext(base({ lastShownAt: yesterday, dayShownAt: yesterday }), NOW)).toBeNull();
    expect(revealNext(base({ lastShownAt: yesterday, dayShownAt: yesterday }), new Date(Date.parse(yesterday) + 2 * DAY))).toBe("board");
  });

  test("never on two page loads in a row: the load after the one that showed a dialog shows none; the next load may", () => {
    let saved: RevealsSaved = {};
    let loads: RevealLoads = revealSeeLoad({}, "load-aaaa")!;
    saved = revealStamp(saved, at(7, 23).toISOString(), { spaced: false, load: "load-aaaa" });
    loads = revealSeeLoad(loads, "load-bbbb")!;
    // A new day, the spacing kept: still not on this load.
    const free = (load: string) => revealLineFree("setup", base({ dayShownAt: saved.dayShownAt, afterShowLoad: revealAfterShowLoad(saved.shownLoad, loads, load) }), NOW);
    expect(free("load-bbbb")).toBe(false);
    // The same load reading again changes nothing.
    expect(revealSeeLoad(loads, "load-bbbb")).toBeNull();
    loads = revealSeeLoad(loads, "load-cccc")!;
    expect(free("load-cccc")).toBe(true);
    // A page that sends no load id is never held back by this rule.
    expect(revealAfterShowLoad(saved.shownLoad, loads, null)).toBe(false);
  });

  test("the gap after Not now: four days, where it is two otherwise", () => {
    const shownAt = at(4, 12).toISOString();
    const after = (ms: number, notNow: boolean) => revealNext(base({ lastShownAt: shownAt, dayShownAt: shownAt, notNowAt: notNow ? shownAt : null, open: { steps: true } }), new Date(Date.parse(shownAt) + ms));
    expect(after(2 * DAY, false)).toBe("steps");
    expect(after(2 * DAY, true)).toBeNull();
    expect(after(4 * DAY - 1, true)).toBeNull();
    expect(after(4 * DAY, true)).toBe("steps");
  });

  test("an offer whose moment never comes retires after 14 days, and the one behind it goes", () => {
    const since = (ms: number) => ({ board: new Date(NOW.getTime() - ms).toISOString() });
    // Alone in line, it stays next for 14 days (patience has nobody to let pass)...
    expect(revealNext(base({ open: { board: true }, waitingSince: since(REVEAL_RETIRE_MS - 1) }), NOW)).toBe("board");
    // ...then retires without a word, and it can no longer be claimed.
    expect(revealNext(base({ open: { board: true }, waitingSince: since(REVEAL_RETIRE_MS) }), NOW)).toBeNull();
    expect(revealMayClaim("board", base({ open: { board: true }, waitingSince: since(REVEAL_RETIRE_MS) }), NOW)).toBe(false);
    // With the Checklist behind it, the Checklist goes.
    expect(revealNext(base({ waitingSince: since(REVEAL_RETIRE_MS) }), NOW)).toBe("steps");
  });

  test("day 0 is setup only: no offer on the first day, the agent note may", () => {
    const morning = at(0, 9);
    const day0 = base({ firstUseAt: morning.toISOString(), open: { snooze: true, board: true, steps: true } });
    expect(revealNext(day0, at(0, 20))).toBeNull();
    expect(revealLineFree("setup", day0, at(0, 20))).toBe(true);
  });

  test("an update-day dialog needs no tenure and no first use; an offer needs both", () => {
    expect(revealNext(base({ firstUseAt: null, open: { sound: true, snooze: true } }), NOW)).toBe("sound");
    expect(revealNext(base({ firstUseAt: null, open: { snooze: true } }), NOW)).toBeNull();
  });

  test("heavy use: 10 threads read in 7 days, on 2 days or more; reads older than 7 days do not count", () => {
    const read = (n: number, day: number) => Array.from({ length: n }, (_, i) => ({ threadId: `d${day}-${i}`, at: at(day, 10).toISOString() }));
    expect(revealHeavyUse(read(10, 9), NOW)).toBe(false);
    expect(revealHeavyUse([...read(9, 9), ...read(1, 8)], NOW)).toBe(true);
    expect(revealHeavyUse([...read(9, 9), ...read(1, 2)], NOW)).toBe(false);
    // The same thread read twice is one thread.
    expect(revealHeavyUse([...read(9, 9), { threadId: "d9-0", at: at(8, 10).toISOString() }], NOW)).toBe(false);
  });

  test("a dev build keeps no line: the agent note is always free", () => {
    expect(revealLineFree("setup", base({ release: false, dayShownAt: at(10, 8).toISOString(), afterShowLoad: true }), NOW)).toBe(true);
  });
});
