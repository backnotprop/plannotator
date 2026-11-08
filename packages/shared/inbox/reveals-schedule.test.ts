/**
 * The schedule of the Inbox's one-time dialogs (approval "inbox-one-time-dialogs", 2026-11-06,
 * `.product/approved/inbox-one-time-dialogs/timeline-inbox.html`), by a clock the test moves over 30 days.
 *
 * A machine keeps what config.json keeps for the line (`inboxReveals`) and changes it only through the module's own
 * helpers, as packages/server/inbox.ts does: a page load is seen (`revealSeeLoad`), the page arms `revealNext`, the
 * agent note asks `revealLineFree("setup")`, a claim stamps (`revealStamp`), a Not now stamps (`revealStampNotNow`).
 * Each user brings their own loads, reads and moments (what the page would see). Bro mode and List view are in the
 * real queue, so the real table is what is tested.
 *
 * What regresses: a heavy user's dialogs leaving their approved days (setup on day 0, then one a day from day 2: the
 * owner, 2026-11-06, "one day apart, three after a Not now: a heavy user sees all five by about day 5"); List
 * view not going ahead of the other offers once its moment comes (the approval's change: not day 10, but the first free
 * day after the list grows taller than the screen); a light user getting a heavy-use dialog; two dialogs on one day,
 * or on two page loads in a row (an old tab reading again included); the gap after an offer's Not now; an offer whose
 * moment never comes not retiring after 14 days (an update-day dialog never retires); update-day dialogs coming back to
 * back; an unanswered agent note taking another day; the "Star the repo" ask (approval "star-ask") not going from the
 * second day of use (the owner, 2026-11-06), or moving any other dialog's day (it stays outside the line's order).
 */
import { describe, expect, test } from "bun:test";
import {
  CODE_REVIEW_OFFER,
  INBOX_REVEALS,
  REVEAL_RETIRE_MS,
  REVEAL_LOADS_KEPT,
  revealAfterShowLoad,
  revealAgentNoteAgents,
  revealAgentNoteNew,
  revealAhead,
  revealAsideNow,
  revealDay,
  revealHeavyUse,
  revealLineFree,
  revealMayClaim,
  revealNext,
  revealNotNowAllowed,
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

const BRO: RevealId = "bro";
const LIST_VIEW: RevealId = "list_view";
const TABLE: readonly RevealEntry[] = INBOX_REVEALS;

test("Bro mode is registered in the real queue as the approval places it: right after Snooze, an offer for heavy use, never on day 0 or 1", () => {
  const after = INBOX_REVEALS.findIndex((entry) => entry.id === "snooze") + 1;
  expect(INBOX_REVEALS[after]).toEqual({ id: BRO, kind: "offer", tenureMs: 2 * DAY, minThreads: 0, heavyUse: true, enabled: true });
});

test("List view is registered in the real queue as the approval places it: last, an offer, ahead at its moment", () => {
  expect(INBOX_REVEALS.at(-1)).toEqual({ id: LIST_VIEW, kind: "offer", tenureMs: 2 * DAY, minThreads: 15, ahead: true, enabled: true });
});

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
  /** Code review was never decided (config.json `inboxCodeReview` unset) and is no longer held: its offer is open. */
  codeReviewOff?: boolean;
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
        open: Object.fromEntries(
          TABLE.map((entry) => [entry.id, !done.has(entry.id) && (entry.id === CODE_REVIEW_OFFER.id ? user.codeReviewOff === true : entry.kind === "offer" || user.update)]),
        ),
        waitingSince: saved.waitingSince,
      });
      const show = (id: Dialog, spaced: boolean) => {
        saved = revealStamp(saved, now.toISOString(), { spaced, load });
        if (id !== "agent_note" && user.notNow?.includes(id)) saved = revealStampNotNow(saved, now.toISOString());
        done.add(id);
        shown.push({ id, day, at: now });
      };
      // The page: the sound first (it opens at load), then the agent note (an agent with no note: on day 0 for
      // everyone, after the tour screen), then an `ahead` offer whose moment has come (List view), then whatever the
      // line has next, at its moment.
      const next = revealNext(state(), now, TABLE);
      const ahead = revealAhead(state(), now, TABLE);
      if (next && !saved.waitingSince?.[next]) saved = { ...saved, waitingSince: { ...saved.waitingSince, [next]: now.toISOString() } };
      if (next === "sound") {
        show("sound", true);
        continue;
      }
      // Code review's day-0 offer: at once, once the tour screen is gone and before the agent note, which waits for it
      // (codeReviewOffer.ts `settled`).
      if (next === CODE_REVIEW_OFFER.id && revealMayClaim(next, state(), now, TABLE)) {
        show(next, true);
        continue;
      }
      if (!done.has("agent_note") && revealLineFree("setup", state(), now)) {
        show("agent_note", false);
        continue;
      }
      const early = ahead.find((id) => user.moment(id, day) && revealMayClaim(id, state(), now, TABLE));
      if (early) {
        show(early, true);
        continue;
      }
      if (next && user.moment(next, day) && revealMayClaim(next, state(), now, TABLE)) {
        show(next, true);
        continue;
      }
      // An `aside` entry (the star ask) at a calm moment the line left free: it stamps nothing of the line.
      const aside = revealAsideNow(state(), now, TABLE).find((id) => user.moment(id, day));
      if (aside) {
        done.add(aside);
        shown.push({ id: aside, day, at: now });
      }
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
  // Snooze needs two threads read and left for a day: from day 1. The grouped list grows taller than the screen on
  // day 5 (List view's moment).
  moment: (id, day) => (id === "snooze" ? day >= 1 : id === LIST_VIEW ? day >= 5 : true),
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
  test("setup on day 0, the star ask on day 1 (aside: it moves no one), then one a day: Snooze 2, Bro mode 3, the Board 4; the list outgrows the screen on day 5, so List view goes on 5, ahead of the Checklist (6)", () => {
    const shown = simulate(HEAVY);
    expect(shown.map((s) => [s.id, s.day])).toEqual([
      ["agent_note", 0],
      ["star", 1],
      ["snooze", 2],
      [BRO, 3],
      ["board", 4],
      [LIST_VIEW, 5],
      ["steps", 6],
    ]);
    expectOnePerDay(shown);
  });

  test("a list taller than the screen from the start: List view on the first free day (2), ahead of Snooze", () => {
    const shown = simulate({ ...HEAVY, moment: (id, day) => id !== "snooze" || day >= 1 });
    expect(shown.map((s) => [s.id, s.day])).toEqual([
      ["agent_note", 0],
      ["star", 1],
      [LIST_VIEW, 2],
      ["snooze", 3],
      [BRO, 4],
      ["board", 5],
      ["steps", 6],
    ]);
  });

  test("a Not now on Bro mode: the next offer waits three days, not one", () => {
    const shown = simulate({ ...HEAVY, notNow: [BRO] });
    expect(days(shown)).toEqual({ agent_note: 0, snooze: 2, [BRO]: 3, [LIST_VIEW]: 6, board: 7, steps: 8, star: 1 });
  });
});

describe("Code review's offer (approval \"code-review-offer-card\": show up about immediately)", () => {
  test("a new user with Code review off: the offer on day 0, before the agent note, which takes day 1; the offers keep their days", () => {
    const shown = simulate({ ...HEAVY, codeReviewOff: true });
    expect(shown.map((s) => [s.id, s.day])).toEqual([
      ["code_review", 0],
      ["agent_note", 1],
      ["snooze", 2],
      [BRO, 3],
      ["board", 4],
      [LIST_VIEW, 5],
      ["steps", 6],
      // The star ask (aside) waits for the first day the line leaves free, and moves no one.
      ["star", 7],
    ]);
    // The first load of day 0 shows it: about immediately.
    expect(shown[0]!.at).toEqual(at(0, HEAVY.loads(0)[0]!));
    expectOnePerDay(shown);
  });

  test("Not now on it is final, and the next offer waits three days", () => {
    const shown = simulate({ ...HEAVY, codeReviewOff: true, notNow: ["code_review"] });
    expect(shown.filter((s) => s.id === "code_review")).toHaveLength(1);
    expect(days(shown)).toMatchObject({ code_review: 0, agent_note: 1, snooze: 3 });
  });

  test("an update day with Code review off: the offer first, then the update-day dialogs one a day", () => {
    const shown = simulate({ ...UPGRADER, codeReviewOff: true });
    expect(shown.slice(0, 3).map((s) => [s.id, s.day])).toEqual([
      ["code_review", 0],
      ["sound", 1],
      ["agent_note", 2],
    ]);
    expectOnePerDay(shown);
  });

  test("Code review decided (on, or switched off by the person) or held: never offered", () => {
    expect(simulate(HEAVY).some((s) => s.id === "code_review")).toBe(false);
  });
});

describe("30 days of a light user", () => {
  test("setup on day 0, Snooze about day 7, the Checklist late; never Bro mode, the Board or List view", () => {
    const shown = simulate(LIGHT);
    const got = days(shown);
    expect(got.agent_note).toBe(0);
    expect(got.snooze).toBe(7);
    // The star ask on day 4: their first load with the line free (day 2's load comes right after the agent note's),
    // beside Snooze waiting for its moment, and Snooze's day unmoved.
    expect(got.star).toBe(4);
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
  test("the sound on the update day, the agent note the day after, list options on day 2, voice on day 3: one a day, and nothing ahead of them", () => {
    const shown = simulate(UPGRADER);
    expect(shown.map((s) => [s.id, s.day])).toEqual([
      ["sound", 0],
      ["agent_note", 1],
      ["list_intro", 2],
      ["voice", 3],
      [BRO, 4],
      [LIST_VIEW, 5],
      ["star", 6],
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
    // An offer yesterday evening: the agent note may show today, the next offer waits out its full day.
    const yesterday = at(9, 21).toISOString();
    expect(revealLineFree("setup", base({ lastShownAt: yesterday, dayShownAt: yesterday }), NOW)).toBe(true);
    expect(revealNext(base({ lastShownAt: yesterday, dayShownAt: yesterday }), NOW)).toBeNull();
    expect(revealNext(base({ lastShownAt: yesterday, dayShownAt: yesterday }), new Date(Date.parse(yesterday) + DAY - 1))).toBeNull();
    expect(revealNext(base({ lastShownAt: yesterday, dayShownAt: yesterday }), new Date(Date.parse(yesterday) + DAY))).toBe("board");
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

  test("the gap after Not now: three days, where it is one otherwise (the owner, 2026-11-06)", () => {
    const shownAt = at(4, 12).toISOString();
    const after = (ms: number, notNow: boolean) => revealNext(base({ lastShownAt: shownAt, dayShownAt: shownAt, notNowAt: notNow ? shownAt : null, open: { steps: true } }), new Date(Date.parse(shownAt) + ms));
    expect(after(DAY - 1, false)).toBeNull();
    expect(after(DAY, false)).toBe("steps");
    expect(after(DAY, true)).toBeNull();
    expect(after(3 * DAY - 1, true)).toBeNull();
    expect(after(3 * DAY, true)).toBe("steps");
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

  test("Code review's offer is next on day 0, with first use not known yet, ahead of the sound; its Not now is an offer's", () => {
    const fresh = base({ firstUseAt: null, threads: 0, open: { code_review: true, sound: true, snooze: true } });
    expect(revealNext(fresh, at(0, 9))).toBe("code_review");
    expect(revealMayClaim("code_review", fresh, at(0, 9))).toBe(true);
    // Shown: the agent note waits for the next day; the sound for the next day too.
    const after = base({ ...fresh, lastShownAt: at(0, 9).toISOString(), dayShownAt: at(0, 9).toISOString(), open: { sound: true } });
    expect(revealLineFree("setup", after, at(0, 20))).toBe(false);
    expect(revealNext(after, at(1, 9))).toBe("sound");
    expect(revealNotNowAllowed("code_review")).toBe(true);
    // Not open (decided, or held back): nothing on day 0.
    expect(revealNext(base({ firstUseAt: null, threads: 0, open: { snooze: true } }), at(0, 9))).toBeNull();
  });

  test("heavy use: 10 threads read in 7 days, on 2 days or more; reads older than 7 days do not count", () => {
    const read = (n: number, day: number) => Array.from({ length: n }, (_, i) => ({ threadId: `d${day}-${i}`, at: at(day, 10).toISOString() }));
    expect(revealHeavyUse(read(10, 9), NOW)).toBe(false);
    expect(revealHeavyUse([...read(9, 9), ...read(1, 8)], NOW)).toBe(true);
    expect(revealHeavyUse([...read(9, 9), ...read(1, 2)], NOW)).toBe(false);
    // The same thread read twice is one thread.
    expect(revealHeavyUse([...read(9, 9), { threadId: "d9-0", at: at(8, 10).toISOString() }], NOW)).toBe(false);
  });

  test("a load counts once: an old tab reading settings again never becomes the newest load, so new loads are not held", () => {
    let loads: RevealLoads = revealSeeLoad({}, "tab-a-load")!;
    const shownLoad = "tab-a-load";
    // Tab A showed a dialog. Days later it comes back and reads settings again, before each new page opens.
    for (const fresh of ["tab-b-load", "phone-load", "tab-d-load"]) {
      expect(revealSeeLoad(loads, "tab-a-load")).toBeNull();
      loads = revealSeeLoad(loads, fresh) ?? loads;
    }
    // Only the load first seen right after A is held; the phone and tab D are not.
    expect(revealAfterShowLoad(shownLoad, loads, "tab-b-load")).toBe(true);
    expect(revealAfterShowLoad(shownLoad, loads, "phone-load")).toBe(false);
    expect(revealAfterShowLoad(shownLoad, loads, "tab-d-load")).toBe(false);
  });

  test("the load right after a show stays held for its whole life, also once newer loads came; a load never seen is not held", () => {
    let loads: RevealLoads = revealSeeLoad({}, "load-a")!;
    // B opened before A's dialog showed (A's moment came later): still the load right after it.
    loads = revealSeeLoad(loads, "load-b")!;
    loads = revealSeeLoad(loads, "load-c")!;
    expect(revealAfterShowLoad("load-a", loads, "load-b")).toBe(true);
    expect(revealAfterShowLoad("load-a", loads, "load-c")).toBe(false);
    // After a restart (nothing in memory) or a load forgotten long ago: never held.
    expect(revealAfterShowLoad("load-a", {}, "load-b")).toBe(false);
    for (let i = 0; i < REVEAL_LOADS_KEPT; i++) loads = revealSeeLoad(loads, `later-${i}`)!;
    expect(loads.before!.size).toBe(REVEAL_LOADS_KEPT);
    expect(revealAfterShowLoad("load-a", loads, "load-b")).toBe(false);
  });

  test("List view goes ahead at its moment: armed beside another offer, claimable, but never ahead of an update-day dialog nor outside the line", () => {
    const state = (over: Partial<RevealState> = {}) => base({ open: { snooze: true, board: true, [LIST_VIEW]: true }, ...over });
    expect(revealNext(state(), NOW, TABLE)).toBe("snooze");
    expect(revealAhead(state(), NOW, TABLE)).toEqual([LIST_VIEW]);
    expect(revealMayClaim(LIST_VIEW, state(), NOW, TABLE)).toBe(true);
    // The Board is behind Snooze and not ahead: still no.
    expect(revealMayClaim("board", state(), NOW, TABLE)).toBe(false);
    // An update-day dialog is next: List view waits for it.
    expect(revealAhead(state({ open: { voice: true, snooze: true, [LIST_VIEW]: true } }), NOW, TABLE)).toEqual([]);
    expect(revealMayClaim(LIST_VIEW, state({ open: { voice: true, [LIST_VIEW]: true } }), NOW, TABLE)).toBe(false);
    // The line's rules hold for it too: a dialog today, the gap, or too few threads.
    expect(revealAhead(state({ dayShownAt: at(10, 8).toISOString() }), NOW, TABLE)).toEqual([]);
    expect(revealAhead(state({ lastShownAt: at(9, 13).toISOString() }), NOW, TABLE)).toEqual([]);
    expect(revealAhead(state({ threads: 14 }), NOW, TABLE)).toEqual([]);
    // Alone in line it is simply next.
    expect(revealNext(state({ open: { [LIST_VIEW]: true } }), NOW, TABLE)).toBe(LIST_VIEW);
    expect(revealAhead(state({ open: { [LIST_VIEW]: true } }), NOW, TABLE)).toEqual([]);
  });

  test("Not now waits four days only after an offer: an update-day dialog's Not now is refused", () => {
    for (const offer of ["snooze", "board", "steps"]) expect(revealNotNowAllowed(offer)).toBe(true);
    for (const update of ["sound", "list_intro", "voice", "agent_note", "bogus", 7]) expect(revealNotNowAllowed(update)).toBe(false);
  });

  test("an update-day dialog never retires: voice waiting 30 days for a long reply is still in line (patience lets others pass)", () => {
    const since = { voice: new Date(NOW.getTime() - 30 * DAY).toISOString() };
    expect(revealNext(base({ open: { voice: true }, waitingSince: since }), NOW)).toBe("voice");
    expect(revealNext(base({ open: { voice: true, board: true }, waitingSince: since }), NOW)).toBe("board");
  });

  test("an unanswered agent note shows once for its agents: the next day it asks again, is refused, and the offer gets the day", () => {
    const agents = revealAgentNoteAgents(["codex"])!;
    expect(revealAgentNoteNew(undefined, agents)).toBe(true);
    // Day 0: shown for Codex, left unanswered (the tab closed). Day 2: the same agents, so no show and no stamp.
    let saved: RevealsSaved = revealStamp({}, at(0, 10).toISOString(), { spaced: false, load: "load-a" });
    saved = { ...saved, agentNote: { shownFor: agents } };
    expect(revealAgentNoteNew(saved.agentNote?.shownFor, revealAgentNoteAgents(["codex"])!)).toBe(false);
    expect(revealNext(base({ firstUseAt: at(0, 9).toISOString(), dayShownAt: saved.dayShownAt, open: { snooze: true } }), at(2, 10))).toBe("snooze");
    // A newly connected agent is asked about.
    expect(revealAgentNoteNew(saved.agentNote?.shownFor, revealAgentNoteAgents(["codex", "claude-code"])!)).toBe(true);
    // An older page sends no list: it shows as before. Anything but a list of agent ids is refused.
    expect(revealAgentNoteAgents(undefined)).toBeNull();
    expect(revealAgentNoteNew(["codex"], null)).toBe(true);
    for (const bad of [[], "codex", ["Codex!"], [1], Array.from({ length: 33 }, (_, i) => `a${i}`)]) expect(revealAgentNoteAgents(bad)).toBeUndefined();
  });

  test("a dev build keeps no line: the agent note is always free", () => {
    expect(revealLineFree("setup", base({ release: false, dayShownAt: at(10, 8).toISOString(), afterShowLoad: true }), NOW)).toBe(true);
  });
});
