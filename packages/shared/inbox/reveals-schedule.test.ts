/**
 * The schedule of the Inbox's one-time dialogs (approval "inbox-one-time-dialogs", 2026-11-06,
 * `.product/approved/inbox-one-time-dialogs/timeline-inbox.html`), by a clock the test moves over 30 days.
 *
 * A machine keeps what config.json keeps for the line (`inboxReveals`) and changes it only through the module's own
 * helpers, as packages/server/inbox.ts does: the page arms `revealNext`, the
 * agent note asks `revealLineFree("setup")`, a claim stamps (`revealStamp`), a Not now stamps (`revealStampNotNow`).
 * Each user brings their own loads, reads and moments (what the page would see). Bro mode and List view are in the
 * real queue, so the real table is what is tested.
 *
 * What regresses: a heavy user's dialogs leaving their pace (setup on day 0, then from day 2 each as soon as its
 * tenure, its moment and the gap allow: the owner, 2026-11-09, "the user can wait 20, 40 minutes ... They don't need
 * to wait a whole day"; it was one a day); a dialog waiting for the next calendar day; List
 * view not going ahead of the other offers once its moment comes (the approval's change: not day 10, but as soon as
 * the list grows taller than the screen); a light user getting a heavy-use dialog; two dialogs within 40 minutes,
 * a dialog held back because the last one showed on this page load or the one before (the owner, 2026-11-09:
 * "after 40 minutes, the same tab (or a fresh load) can show the next one"); the gap after an offer's Not now; an offer whose
 * moment never comes not retiring after 14 days (an update-day dialog never retires); update-day dialogs coming back to
 * back; an unanswered agent note taking another slot; the "Star the repo" ask (approval "star-ask") not going from the
 * second day of use (the owner, 2026-11-06), or moving any other dialog (it stays outside the line's order).
 */
import { describe, expect, test } from "bun:test";
import {
  CODE_REVIEW_OFFER,
  INBOX_REVEALS,
  REVEAL_RETIRE_MS,
  REVEAL_SPACING_MS,
  revealAgainAt,
  revealAgentNoteAgents,
  revealAgentNoteNew,
  revealAhead,
  revealAsideNow,
  revealHeavyUse,
  revealLineFree,
  revealMayClaim,
  revealNext,
  revealNotNowAllowed,
  revealStamp,
  revealStampNotNow,
  type RevealEntry,
  type RevealId,
  type RevealState,
  type RevealsSaved,
} from "./reveals";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Day 0, local time: the person's first use (or the update) is that morning. */
const at = (day: number, hour: number) => new Date(2026, 10, 2 + day, hour, 0, 0, 0);

const BRO: RevealId = "bro";
const LIST_VIEW: RevealId = "list_view";
const GRILL_ME: RevealId = "grill_me_tip";
const TABLE: readonly RevealEntry[] = INBOX_REVEALS;

test("Bro mode is registered in the real queue as the owner's order places it (2026-11-10): right after the Checklist, an offer for heavy use, never on day 0 or 1", () => {
  const after = INBOX_REVEALS.findIndex((entry) => entry.id === "steps") + 1;
  expect(INBOX_REVEALS[after]).toEqual({ id: BRO, kind: "offer", tenureMs: 2 * DAY, minThreads: 0, heavyUse: true, enabled: true });
});

test("List view (Grouping) is registered in the real queue as the owner's order places it (2026-11-10): right after the themes dialog, no tenure, an offer, ahead at its moment", () => {
  const after = INBOX_REVEALS.findIndex((entry) => entry.id === "theme_chooser") + 1;
  expect(INBOX_REVEALS[after]).toEqual({ id: LIST_VIEW, kind: "offer", tenureMs: 0, minThreads: 15, ahead: true, enabled: true });
});

const AGENT_RULES: RevealId = "agent_rules";

test('"Set the rules" is registered last of the later group (2026-11-11): an offer after two days and ten threads, so no earlier dialog moves', () => {
  const after = INBOX_REVEALS.findIndex((entry) => entry.id === BRO) + 1;
  expect(INBOX_REVEALS[after]).toEqual({ id: AGENT_RULES, kind: "offer", tenureMs: 2 * DAY, minThreads: 10, enabled: true });
});

test("the grill-me tip is registered beside the line, waiting for every other card: aside, last resort, no tenure", () => {
  const after = INBOX_REVEALS.findIndex((entry) => entry.id === AGENT_RULES) + 1;
  expect(INBOX_REVEALS[after]).toEqual({ id: GRILL_ME, kind: "offer", tenureMs: 0, minThreads: 0, aside: true, lastResort: true, enabled: true });
});

test("the same-day group, in the owner's order (2026-11-10): the tab icon, themes, Grouping, Rows, the sound, voice, none with a tenure; then the later group, each with one", () => {
  const ids = INBOX_REVEALS.filter((entry) => !entry.aside && entry.id !== "code_review").map((entry) => entry.id);
  expect(ids).toEqual(["tab_icon", "theme_chooser", LIST_VIEW, "list_intro", "sound", "voice", "snooze", "board", "steps", BRO, AGENT_RULES]);
  const tenure = (id: RevealId) => INBOX_REVEALS.find((entry) => entry.id === id)!.tenureMs;
  expect(ids.slice(0, 6).map(tenure)).toEqual([0, 0, 0, 0, 0, 0]);
  expect(ids.slice(6).map(tenure)).toEqual([2 * DAY, 3 * DAY, 5 * DAY, 2 * DAY, 2 * DAY]);
  expect(INBOX_REVEALS.find((entry) => entry.id === "tab_icon")).toEqual({ id: "tab_icon", kind: "update", tenureMs: 0, minThreads: 0, enabled: true });
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
  /** The day the person's third question card is answered (grill-me-tip.ts `revealGrillMeGap`): from then the tip is open. Absent: never. */
  grillMeGap?: number;
  /** Still on the default theme (shared/inbox/theme-chooser.ts): the "themes" dialog is open. Absent: a theme was picked. */
  defaultTheme?: boolean;
  noRules?: boolean;
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
  /** The last `aside` card shown (the star ask's `inboxReveals.star.shownAt`). */
  let asideShownAt: string | null = null;
  for (let day = 0; day < days; day++) {
    for (const hour of user.loads(day)) {
      const now = at(day, hour);
      const load = `load-${String(++loadCount).padStart(4, "0")}`;
      for (let i = 0; i < user.readsPerLoad; i++) reads.push({ threadId: `t${readCount++ % Math.max(1, user.threads(day))}`, at: now.toISOString() });
      const state = (): RevealState => ({
        release: true,
        firstUseAt,
        lastShownAt: saved.lastShownAt ?? null,
        dayShownAt: saved.dayShownAt ?? null,
        notNowAt: saved.notNowAt ?? null,
        heavy: revealHeavyUse(reads, now),
        threads: user.threads(day),
        open: Object.fromEntries(
          TABLE.map((entry) => [
            entry.id,
            !done.has(entry.id) && (entry.id === "theme_chooser" ? user.defaultTheme === true : entry.id === CODE_REVIEW_OFFER.id ? user.codeReviewOff === true : entry.id === GRILL_ME ? user.grillMeGap !== undefined && day >= user.grillMeGap : entry.id === AGENT_RULES ? user.noRules === true : entry.kind === "offer" || user.update),
          ]),
        ),
        waitingSince: saved.waitingSince,
        asideShownAt: asideShownAt,
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
        asideShownAt = now.toISOString();
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

/** Never two dialogs within the gap (these people load every two hours at most, so: never on the same load). */
function expectSpaced(shown: Shown[]) {
  const times = shown.map((s) => s.at.getTime());
  expect(times.every((time, i) => i === 0 || time - times[i - 1]! >= REVEAL_SPACING_MS)).toBe(true);
}
/** Each dialog with its day and the hour of the load that showed it. */
const when = (shown: Shown[]) => shown.map((s) => [s.id, s.day, s.at.getHours()]);

describe("30 days of a heavy user", () => {
  test("setup on day 0, the star ask on day 1 (aside: it moves no one), then no waiting for tomorrow nor for another load: Snooze and Bro mode on day 2, one load after the other, the Board when its 3 days are up; the list outgrows the screen on day 5, so List view goes first that day and the Checklist on the next load", () => {
    const shown = simulate(HEAVY);
    expect(when(shown)).toEqual([
      ["agent_note", 0, 9],
      ["star", 1, 9],
      ["snooze", 2, 9],
      // 11:00 is the very next load, two hours on: the gap is over, so it goes.
      [BRO, 2, 11],
      ["board", 3, 9],
      [LIST_VIEW, 5, 9],
      ["steps", 5, 11],
    ]);
    expectSpaced(shown);
  });

  test('"Set the rules", for someone with no rules: once, on day 2 at the load after Bro mode (two days\' use), and every other card keeps its day and hour', () => {
    const shown = simulate({ ...HEAVY, noRules: true });
    expect(when(shown).filter(([id]) => id === AGENT_RULES)).toEqual([[AGENT_RULES, 2, 13]]);
    expect(when(shown).filter(([id]) => id !== AGENT_RULES)).toEqual(when(simulate(HEAVY)));
    expectSpaced(shown);
  });

  test("a list taller than the screen from the start: List view on day 0, the load after the agent note (no 2-day wait since 2026-11-10); the offers keep their days", () => {
    const shown = simulate({ ...HEAVY, moment: (id, day) => id !== "snooze" || day >= 1 });
    expect(when(shown)).toEqual([
      ["agent_note", 0, 9],
      [LIST_VIEW, 0, 11],
      ["star", 1, 9],
      ["snooze", 2, 9],
      [BRO, 2, 11],
      ["board", 3, 9],
      ["steps", 5, 9],
    ]);
    expectSpaced(shown);
  });

  test("a Not now on Bro mode: the next offer waits three days, not 40 minutes", () => {
    const shown = simulate({ ...HEAVY, notNow: [BRO] });
    expect(when(shown)).toEqual([
      ["agent_note", 0, 9],
      ["star", 1, 9],
      ["snooze", 2, 9],
      [BRO, 2, 11],
      // Three days after 11:00 on day 2.
      [LIST_VIEW, 5, 11],
      ["board", 5, 13],
      ["steps", 5, 15],
    ]);
  });
});

describe("the grill-me tip (the owner: \"Sooner: after 3 answered questions, whatever the days, once\")", () => {
  // `grillMeGap`: the day the third question card is answered. The tip never costs another card its slot: every other
  // dialog shows on the load it shows on without the tip, and the tip takes the first moment the line has nothing else
  // for (no card next within its patience, none ahead, the star ask settled and not that day).
  const SCENARIOS: readonly (readonly [string, User, Readonly<Record<number, number>>])[] = [
    // gap day -> tip day
    // List view is next from day 0 (nothing else qualifies yet) and waits for its moment (day 5): the tip passes it once its patience is out, on day 3.
    ["a heavy user", HEAVY, { 0: 3, 3: 3, 8: 8, 12: 12 }],
    ["a heavy user who said Not now to Bro mode", { ...HEAVY, notNow: [BRO] }, { 0: 5, 3: 5, 8: 8, 12: 12 }],
    // The Board's three days and the Checklist's five leave the line empty late on day 2: the tip goes then.
    ["a heavy user whose list is taller than the screen from the start", { ...HEAVY, moment: (id: RevealId, day: number) => id !== "snooze" || day >= 1 }, { 0: 2, 8: 8 }],
    ["a new user with Code review off", { ...HEAVY, codeReviewOff: true }, { 0: 3, 8: 8, 12: 12 }],
    ["a light user (Snooze on 7, the Checklist on 23, the Board never)", LIGHT, { 0: 18, 3: 18, 8: 18 }],
    // List view is next from day 1 and waits for its moment (day 5): the tip passes it once its patience is out.
    ["someone updating on day 0", UPGRADER, { 0: 4, 3: 4, 8: 8 }],
  ];
  for (const [name, user, tips] of SCENARIOS) {
    const without = when(simulate(user));
    for (const [gap, tip] of Object.entries(tips)) {
      test(`${name}, third answer on day ${gap}: every other dialog keeps its day and hour, the tip on day ${tip}`, () => {
        const shown = simulate({ ...user, grillMeGap: Number(gap) });
        const got = days(shown);
        expect(got[GRILL_ME]).toBe(tip);
        expect(when(shown.filter((s) => s.id !== GRILL_ME))).toEqual(without);
        expect(shown.filter((s) => s.id === GRILL_ME)).toHaveLength(1);
        expectSpaced(shown);
      });
    }
  }

  test("no tenure: the line empty from day 0 (every card seen, Code review decided, the star ask settled), the tip on day 0 too, on the load after the agent note's", () => {
    const user: User = { ...HEAVY, seen: ["snooze", BRO, "board", "steps", LIST_VIEW, "star"], grillMeGap: 0 };
    expect(when(simulate(user))).toEqual([
      ["agent_note", 0, 9],
      [GRILL_ME, 0, 11],
    ]);
  });

  test("its moment never comes: never shown, and every other dialog keeps its day", () => {
    const user: User = { ...HEAVY, grillMeGap: 0, moment: (id, day) => id !== GRILL_ME && HEAVY.moment(id, day) };
    const shown = simulate(user, 40);
    expect(shown.some((s) => s.id === GRILL_ME)).toBe(false);
    expect(days(shown)).toEqual(days(simulate(HEAVY, 40)));
  });

  test("shown once: never again, whatever its moment", () => {
    expect(simulate({ ...HEAVY, grillMeGap: 0 }, 40).filter((s) => s.id === GRILL_ME)).toHaveLength(1);
  });

  test("its claim, one moment at a time: never while a card is due, the star ask open or shown today; no Not now", () => {
    const now = at(10, 12);
    const free: RevealState = {
      release: true,
      firstUseAt: at(0, 9).toISOString(),
      lastShownAt: at(8, 9).toISOString(),
      dayShownAt: at(8, 9).toISOString(),
      notNowAt: null,
      heavy: false,
      threads: 1,
      open: { [GRILL_ME]: true },
      asideShownAt: null,
    };
    expect(revealMayClaim(GRILL_ME, free, now)).toBe(true);
    expect(revealAsideNow(free, now)).toEqual([GRILL_ME]);
    // A card next and still within its patience: due, so the tip waits; past its patience, the tip may pass it.
    const due: RevealState = { ...free, open: { ...free.open, snooze: true }, waitingSince: { snooze: at(9, 9).toISOString() } };
    expect(revealMayClaim(GRILL_ME, due, now)).toBe(false);
    expect(revealMayClaim(GRILL_ME, { ...due, waitingSince: { snooze: at(6, 9).toISOString() } }, now)).toBe(true);
    expect(revealMayClaim(GRILL_ME, { ...free, open: { ...free.open, star: true } }, now)).toBe(false);
    expect(revealMayClaim(GRILL_ME, { ...free, asideShownAt: at(10, 9).toISOString() }, now)).toBe(false);
    expect(revealMayClaim(GRILL_ME, { ...free, asideShownAt: at(9, 9).toISOString() }, now)).toBe(true);
    // Another dialog (the agent note) within the gap: not yet; 40 minutes on, the same day, it may.
    expect(revealMayClaim(GRILL_ME, { ...free, dayShownAt: new Date(now.getTime() - 40 * MINUTE + 1).toISOString() }, now)).toBe(false);
    expect(revealMayClaim(GRILL_ME, { ...free, dayShownAt: new Date(now.getTime() - 40 * MINUTE).toISOString() }, now)).toBe(true);
    expect(revealMayClaim(GRILL_ME, { ...free, open: {} }, now)).toBe(false);
    expect(revealNext(free, now)).toBeNull();
    expect(revealNotNowAllowed(GRILL_ME)).toBe(false);
  });
});

describe("Code review's offer (approval \"code-review-offer-card\": show up about immediately)", () => {
  test("a new user with Code review off: the offer on day 0, before the agent note, which follows on the next load the same day; the offers keep their slots", () => {
    const shown = simulate({ ...HEAVY, codeReviewOff: true });
    expect(when(shown)).toEqual([
      ["code_review", 0, 9],
      ["agent_note", 0, 11],
      // The star ask (aside) from the second day, and it moves no one.
      ["star", 1, 9],
      ["snooze", 2, 9],
      [BRO, 2, 11],
      ["board", 3, 9],
      [LIST_VIEW, 5, 9],
      ["steps", 5, 11],
    ]);
    // The first load of day 0 shows it: about immediately.
    expect(shown[0]!.at).toEqual(at(0, HEAVY.loads(0)[0]!));
    expectSpaced(shown);
  });

  test("Not now on it is final, and the next offer waits three days", () => {
    const shown = simulate({ ...HEAVY, codeReviewOff: true, notNow: ["code_review"] });
    expect(shown.filter((s) => s.id === "code_review")).toHaveLength(1);
    // The agent note is setup: it does not wait for the Not now. The first offer does.
    expect(days(shown)).toMatchObject({ code_review: 0, agent_note: 0, snooze: 3 });
  });

  test("an update day with Code review off: the offer first, then the same-day group in its order, one on each load after it", () => {
    const shown = simulate({ ...UPGRADER, codeReviewOff: true });
    expect(when(shown.slice(0, 6))).toEqual([
      ["code_review", 0, 9],
      ["agent_note", 0, 11],
      ["tab_icon", 0, 13],
      ["list_intro", 0, 15],
      ["sound", 0, 17],
      ["voice", 1, 9],
    ]);
    expectSpaced(shown);
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
    // The star ask on day 2: their first load on a later day than the first, beside Snooze waiting for its moment,
    // and Snooze's day unmoved.
    expect(got.star).toBe(2);
    expect(got.steps).toBeGreaterThanOrEqual(20);
    for (const never of [BRO, "board", LIST_VIEW]) expect(got[never]).toBeUndefined();
    expectSpaced(shown);
  });

  test("heavy use is never true for them: Bro mode stays out of the line, whatever its moment", () => {
    const reads = [0, 2, 4].flatMap((day) => [{ threadId: `t${day}`, at: at(day, 10).toISOString() }]);
    expect(revealHeavyUse(reads, at(5, 10))).toBe(false);
  });
});

describe("an update day", () => {
  test("the agent note, the tab icon, Rows, the sound and voice all on the update day, in the owner's order (2026-11-10), one on each load two hours apart, and no later offer ahead of them", () => {
    const shown = simulate(UPGRADER);
    expect(when(shown)).toEqual([
      ["agent_note", 0, 9],
      ["tab_icon", 0, 11],
      ["list_intro", 0, 13],
      ["sound", 0, 15],
      ["voice", 0, 17],
      [BRO, 1, 9],
      ["star", 1, 11],
      // The list outgrows the screen on day 5.
      [LIST_VIEW, 5, 9],
    ]);
    expectSpaced(shown);
  });

  test("someone on the default theme: themes right after the tab icon dialog, the same day, the line's gap apart, ahead of Rows; a new person gets it on day 0", () => {
    const updated = simulate({ ...UPGRADER, defaultTheme: true });
    expect(when(updated).slice(0, 6)).toEqual([
      ["agent_note", 0, 9],
      ["tab_icon", 0, 11],
      ["theme_chooser", 0, 13],
      ["list_intro", 0, 15],
      ["sound", 0, 17],
      ["voice", 1, 9],
    ]);
    expectSpaced(updated);
    // No tab icon dialog for a fresh install: themes is the first of the line, on the first day.
    expect(when(simulate({ ...HEAVY, defaultTheme: true })).slice(0, 2)).toEqual([
      ["agent_note", 0, 9],
      ["theme_chooser", 0, 11],
    ]);
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

  test("no two within 40 minutes, and no waiting for tomorrow: the agent note holds every offer and itself back for the gap, then both are free the same day", () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const justNow = ago(40 * MINUTE - 1);
    expect(revealNext(base({ dayShownAt: justNow }), NOW)).toBeNull();
    expect(revealLineFree("setup", base({ dayShownAt: justNow }), NOW)).toBe(false);
    expect(revealNext(base({ dayShownAt: ago(40 * MINUTE) }), NOW)).toBe("board");
    expect(revealLineFree("setup", base({ dayShownAt: ago(40 * MINUTE) }), NOW)).toBe(true);
    // An offer this morning: the agent note waits out the same gap after it, and so does the next offer.
    const offer = (ms: number) => base({ lastShownAt: ago(ms), dayShownAt: ago(ms) });
    expect(revealLineFree("setup", offer(40 * MINUTE - 1), NOW)).toBe(false);
    expect(revealNext(offer(40 * MINUTE - 1), NOW)).toBeNull();
    expect(revealLineFree("setup", offer(40 * MINUTE), NOW)).toBe(true);
    expect(revealNext(offer(40 * MINUTE), NOW)).toBe("board");
    // The star ask or the grill-me tip a moment ago holds them as well.
    expect(revealNext(base({ asideShownAt: justNow }), NOW)).toBeNull();
    expect(revealLineFree("setup", base({ asideShownAt: justNow }), NOW)).toBe(false);
  });

  test("the gap after Not now: three days, where it is 40 minutes otherwise (the owner, 2026-11-06 and 2026-11-09)", () => {
    const shownAt = at(6, 12).toISOString();
    const after = (ms: number, notNow: boolean) => revealNext(base({ lastShownAt: shownAt, dayShownAt: shownAt, notNowAt: notNow ? shownAt : null, open: { steps: true } }), new Date(Date.parse(shownAt) + ms));
    expect(after(40 * MINUTE - 1, false)).toBeNull();
    expect(after(40 * MINUTE, false)).toBe("steps");
    expect(after(40 * MINUTE, true)).toBeNull();
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
    // Shown: the agent note and the sound wait out the gap, then go the same day.
    const after = base({ ...fresh, lastShownAt: at(0, 9).toISOString(), dayShownAt: at(0, 9).toISOString(), open: { sound: true } });
    const later = (ms: number) => new Date(at(0, 9).getTime() + ms);
    expect(revealLineFree("setup", after, later(40 * MINUTE - 1))).toBe(false);
    expect(revealNext(after, later(40 * MINUTE - 1))).toBeNull();
    expect(revealLineFree("setup", after, later(40 * MINUTE))).toBe(true);
    expect(revealNext(after, later(40 * MINUTE))).toBe("sound");
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

  test("when to ask again: the next date that can change the line, and none when no date can (a page keeps one timer for it, never a poll)", () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const inMs = (state: RevealState) => {
      const again = revealAgainAt(state, NOW);
      return again === null ? null : again - NOW.getTime();
    };
    // Nothing shown, nothing waiting on a date: no moment, so nothing is scheduled.
    expect(inMs(base())).toBeNull();
    expect(inMs(base({ open: {} }))).toBeNull();
    // Inside the gap after a dialog (the line's own, the agent note, a card that stands aside): its end.
    expect(inMs(base({ lastShownAt: ago(10 * MINUTE) }))).toBe(30 * MINUTE);
    expect(inMs(base({ dayShownAt: ago(39 * MINUTE) }))).toBe(MINUTE);
    expect(inMs(base({ asideShownAt: ago(25 * MINUTE) }))).toBe(15 * MINUTE);
    // The gap over: not again for it.
    expect(inMs(base({ lastShownAt: ago(40 * MINUTE) }))).toBeNull();
    // After a Not now: the gap's end first, then the three days' end.
    expect(inMs(base({ lastShownAt: ago(10 * MINUTE), notNowAt: ago(10 * MINUTE) }))).toBe(30 * MINUTE);
    expect(inMs(base({ lastShownAt: ago(DAY), notNowAt: ago(DAY) }))).toBe(2 * DAY);
    // An open entry's tenure still ahead: the Checklist's five days for someone on day 4; one already decided adds none.
    const day4 = { firstUseAt: ago(4 * DAY) };
    expect(inMs(base({ ...day4, open: { steps: true } }))).toBe(DAY);
    expect(inMs(base({ ...day4, open: { steps: false } }))).toBeNull();
    // An entry waiting for its moment: when its patience ends, the line lets the next one pass; then its 14 days.
    expect(inMs(base({ open: { board: true }, waitingSince: { board: ago(DAY) } }))).toBe(2 * DAY);
    expect(inMs(base({ open: { board: true }, waitingSince: { board: ago(4 * DAY) } }))).toBe(10 * DAY);
    // An update-day dialog never retires: past its patience no date is left.
    expect(inMs(base({ open: { voice: true }, waitingSince: { voice: ago(4 * DAY) } }))).toBeNull();
    // The star ask waits for the day after first use.
    const firstMorning = at(10, 9).toISOString();
    expect(revealAgainAt(base({ firstUseAt: firstMorning, open: { star: true } }), NOW)).toBe(at(11, 0).getTime());
    // A dev build keeps no line.
    expect(inMs(base({ release: false, lastShownAt: ago(MINUTE) }))).toBeNull();
  });

  test("List view goes ahead at its moment: armed beside another offer or an update-day dialog behind it, claimable, never holding the line, never ahead of the tab icon or themes dialogs nor outside the line", () => {
    const state = (over: Partial<RevealState> = {}) => base({ open: { snooze: true, board: true, [LIST_VIEW]: true }, ...over });
    expect(revealNext(state(), NOW, TABLE)).toBe("snooze");
    expect(revealAhead(state(), NOW, TABLE)).toEqual([LIST_VIEW]);
    expect(revealMayClaim(LIST_VIEW, state(), NOW, TABLE)).toBe(true);
    // The Board is behind Snooze and not ahead: still no.
    expect(revealMayClaim("board", state(), NOW, TABLE)).toBe(false);
    // An update-day dialog behind it in the order is next (Rows, the sound, voice): List view never holds them (only the
    // page can see its moment), and is armed beside them.
    for (const behind of ["list_intro", "sound", "voice"] as const) {
      const both = state({ open: { [behind]: true, snooze: true, [LIST_VIEW]: true } });
      expect(revealNext(both, NOW, TABLE)).toBe(behind);
      expect(revealAhead(both, NOW, TABLE)).toEqual([LIST_VIEW]);
      expect(revealMayClaim(LIST_VIEW, both, NOW, TABLE)).toBe(true);
    }
    // The tab icon or the themes dialog is next: they come before it, so it waits.
    for (const before of ["tab_icon", "theme_chooser"] as const) {
      const both = state({ open: { [before]: true, [LIST_VIEW]: true } });
      expect(revealNext(both, NOW, TABLE)).toBe(before);
      expect(revealAhead(both, NOW, TABLE)).toEqual([]);
      expect(revealMayClaim(LIST_VIEW, both, NOW, TABLE)).toBe(false);
    }
    // The line's rules hold for it too: the gap after any dialog (the agent note's stamp, the line's own), or too few threads.
    const halfHourAgo = new Date(NOW.getTime() - 30 * MINUTE).toISOString();
    expect(revealAhead(state({ dayShownAt: halfHourAgo }), NOW, TABLE)).toEqual([]);
    expect(revealAhead(state({ lastShownAt: halfHourAgo }), NOW, TABLE)).toEqual([]);
    expect(revealAhead(state({ lastShownAt: at(10, 8).toISOString(), dayShownAt: at(10, 8).toISOString() }), NOW, TABLE)).toEqual([LIST_VIEW]);
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

  test("an unanswered agent note shows once for its agents: later it asks again, is refused, and the offer gets the slot", () => {
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
    expect(revealLineFree("setup", base({ release: false, dayShownAt: new Date(NOW.getTime() - MINUTE).toISOString() }), NOW)).toBe(true);
  });
});
