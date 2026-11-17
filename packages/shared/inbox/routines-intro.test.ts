/**
 * Who the Routines intro is for, and its day of its own (shared/inbox/routines-intro.ts, reveals.ts `routines`).
 *
 * What regresses: counting days in UTC instead of the person's local day; a day with one send counting; Inbox notes
 * (an ack, a skip line), a routine's run dividers or an agent's words counting as sends; someone already here not
 * qualifying from their history; any skip condition (Windows, Routines decided on or off, a routine made, launches
 * off) letting it through; the store walked when a cheaper fact already said no, on a day the line would refuse it
 * anyway, or again after three good days were found; it sharing a local day with another one-time dialog or letting
 * anything else (a dialog, the agent note, a tip, the star ask) follow it that day; the line not asking again the next
 * day; first run; a 23- or 25-hour day around a daylight-saving change.
 */
import { describe, expect, test } from "bun:test";
import { revealAgainAt, revealAsideNow, revealLineFree, revealMayClaim, revealNext, type RevealState } from "./reveals";
import { routinesIntroGoodDays, routinesIntroGoodDaysOnce, routinesIntroOpen, routinesIntroSend, routinesIntroWaits, type RoutinesIntroFacts } from "./routines-intro";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Local time on 2026-11-`d`. */
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();

describe("three good days of sends", () => {
  test("three local days with two sends each qualify; any order, any time in the past", () => {
    expect(routinesIntroGoodDays([local(3, 10), local(1, 9), local(3, 11), local(2, 9), local(1, 18), local(2, 20)])).toBe(true);
    // An existing user: the days were weeks ago.
    expect(routinesIntroGoodDays([local(1, 9), local(1, 10), local(2, 9), local(2, 10), local(3, 9), local(3, 10)].map((iso) => new Date(Date.parse(iso) - 40 * DAY).toISOString()))).toBe(true);
  });

  test("one send short on any day, or only two days however busy: no", () => {
    expect(routinesIntroGoodDays([local(1, 9), local(1, 10), local(2, 9), local(2, 10), local(3, 9)])).toBe(false);
    expect(routinesIntroGoodDays(Array.from({ length: 40 }, (_, i) => local(1 + (i % 2), 8 + (i % 10))))).toBe(false);
    expect(routinesIntroGoodDays([])).toBe(false);
  });

  test("the day is the person's local calendar day: 23:59 and 00:01 are two days, and two sends either side of midnight make no day", () => {
    // Two sends late on the 1st, two early on the 2nd, two on the 3rd: three days.
    expect(routinesIntroGoodDays([local(1, 23, 30), local(1, 23, 59), local(2, 0, 1), local(2, 0, 30), local(3, 12), local(3, 13)])).toBe(true);
    // One each side of each midnight: no day has two.
    expect(routinesIntroGoodDays([local(1, 23, 59), local(2, 0, 1), local(2, 23, 59), local(3, 0, 1), local(3, 23, 59), local(4, 0, 1)])).toBe(false);
  });

  test("it stops reading at the third good day", () => {
    let read = 0;
    const sends = function* () {
      for (const iso of [local(1, 9), local(1, 10), local(2, 9), local(2, 10), local(3, 9), local(3, 10)]) {
        read++;
        yield iso;
      }
      throw new Error("read past the third good day");
    };
    expect(routinesIntroGoodDays(sends())).toBe(true);
    expect(read).toBe(6);
  });

  test("a send is the person's own words: not an agent's, not an Inbox note, not a routine's run", () => {
    const person = { author: { kind: "person" }, created_at: local(1, 9) };
    expect(routinesIntroSend(person)).toBe(true);
    expect(routinesIntroSend({ ...person, author: { kind: "agent" } })).toBe(false);
    expect(routinesIntroSend({ ...person, ack_of: "msg_1" })).toBe(false);
    expect(routinesIntroSend({ ...person, set_aside: ["q_1"] })).toBe(false);
    expect(routinesIntroSend({ ...person, reopened: ["q_1"] })).toBe(false);
    expect(routinesIntroSend({ ...person, scheduled_run: { run: 3 } })).toBe(false);
    expect(routinesIntroSend({ ...person, scheduled_run: {} })).toBe(false);
  });
});

describe("who: each skip condition", () => {
  const good = [local(1, 9), local(1, 10), local(2, 9), local(2, 10), local(3, 9), local(3, 10)];
  const facts = (over: Partial<RoutinesIntroFacts> = {}): RoutinesIntroFacts => ({ supported: true, saved: () => undefined, routineMade: () => false, launchOn: () => true, goodDays: () => routinesIntroGoodDays(good), ...over });
  const walked = () => {
    throw new Error("walked the store");
  };

  test("open: offered here, never decided, no routine, launches on, three good days", () => {
    expect(routinesIntroOpen(facts())).toBe(true);
  });

  for (const [name, over] of [
    ["Routines are not offered here (Windows)", { supported: false }],
    ["Routines turned on", { saved: () => true }],
    ["Routines turned off by the person", { saved: () => false }],
    ["a routine exists (or existed)", { routineMade: () => true }],
    ["Start agents from New message is off", { launchOn: () => false }],
  ] as const) {
    test(`closed when ${name}, without walking the store, even on a day the walk would wait`, () => {
      expect(routinesIntroOpen(facts({ ...over, goodDays: walked }))).toBe(false);
      expect(routinesIntroOpen(facts({ ...over, goodDays: walked, waits: () => true }))).toBe(false);
    });
  }

  test("closed without three good days", () => {
    expect(routinesIntroOpen(facts({ goodDays: () => routinesIntroGoodDays(good.slice(1)) }))).toBe(false);
  });

  test("on a day the line would refuse it anyway, open without walking the store (so the line still names when it could go)", () => {
    expect(routinesIntroOpen(facts({ waits: () => true, goodDays: walked }))).toBe(true);
    expect(routinesIntroOpen(facts({ waits: () => false, goodDays: () => false }))).toBe(false);
  });

  test("three good days found once are kept: the store is never walked again; until then each read walks it", () => {
    let walks = 0;
    let sends = good.slice(1);
    const goodDays = routinesIntroGoodDaysOnce(() => {
      walks++;
      return sends;
    });
    expect(goodDays()).toBe(false);
    expect(goodDays()).toBe(false);
    expect(walks).toBe(2);
    sends = good;
    expect(goodDays()).toBe(true);
    expect(walks).toBe(3);
    for (let i = 0; i < 5; i++) expect(goodDays()).toBe(true);
    expect(walks).toBe(3);
  });
});

describe("when the walk waits", () => {
  const NOW = new Date(2026, 10, 10, 15, 0);
  const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

  test("in its first two days, and while first use is unknown", () => {
    expect(routinesIntroWaits({ firstUseAt: null }, NOW)).toBe(true);
    expect(routinesIntroWaits({ firstUseAt: at(DAY) }, NOW)).toBe(true);
    expect(routinesIntroWaits({ firstUseAt: at(2 * DAY - HOUR) }, NOW)).toBe(true);
    expect(routinesIntroWaits({ firstUseAt: at(2 * DAY) }, NOW)).toBe(false);
    expect(routinesIntroWaits({ firstUseAt: at(30 * DAY) }, NOW)).toBe(false);
  });

  test("on a local day something else was shown; not when that was yesterday", () => {
    const first = at(30 * DAY);
    for (const stamp of ["lastShownAt", "dayShownAt", "asideShownAt", "tipShownAt"] as const) {
      expect(routinesIntroWaits({ firstUseAt: first, [stamp]: at(5 * HOUR) }, NOW)).toBe(true);
      expect(routinesIntroWaits({ firstUseAt: first, [stamp]: new Date(2026, 10, 9, 23, 0).toISOString() }, NOW)).toBe(false);
    }
  });

  test("it waits exactly while the line refuses it, so the answer it skips could never have shown it", () => {
    const first = at(30 * DAY);
    for (const over of [{ firstUseAt: null }, { firstUseAt: at(DAY) }, { firstUseAt: first, lastShownAt: at(5 * HOUR) }, { firstUseAt: first, tipShownAt: at(3 * HOUR) }]) {
      const state: RevealState = { release: true, threads: 20, open: { routines: true }, ...over };
      expect(routinesIntroWaits(state, NOW)).toBe(true);
      expect(revealMayClaim("routines", state, NOW)).toBe(false);
    }
  });
});

describe("daylight saving: the person's local day, 23 or 25 hours long", () => {
  /** Runs `body` with the process in New York's time zone (DST began 2026-03-08 and ended 2026-11-01), then restores it. */
  const inNewYork = (body: () => void) => {
    const saved = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      body();
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  };

  test("the 25-hour day DST ends: 00:30 and 23:30 (24 h apart) are one day; the next morning is another", () => {
    inNewYork(() => {
      const nov = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
      expect(Date.parse(nov(1, 23, 30)) - Date.parse(nov(1, 0, 30))).toBe(24 * HOUR);
      expect(routinesIntroGoodDays([nov(1, 0, 30), nov(1, 23, 30), nov(2, 0, 30), nov(2, 9), nov(3, 9), nov(3, 10)])).toBe(true);
      // One send each side of the long day's end: no day of two.
      expect(routinesIntroGoodDays([nov(1, 23, 59), nov(2, 0, 1), nov(3, 9), nov(3, 10), nov(4, 9), nov(4, 10)])).toBe(false);
    });
  });

  test("the 23-hour day DST begins: 23:30 and the next 00:30 are two days", () => {
    inNewYork(() => {
      const mar = (d: number, h: number, m = 0) => new Date(2026, 2, d, h, m).toISOString();
      expect(routinesIntroGoodDays([mar(8, 0, 30), mar(8, 23, 30), mar(9, 0, 30), mar(9, 9), mar(10, 9), mar(10, 10)])).toBe(true);
      expect(routinesIntroGoodDays([mar(8, 23, 30), mar(9, 0, 30), mar(10, 9), mar(10, 10), mar(11, 9), mar(11, 10)])).toBe(false);
    });
  });

  test("its day of its own ends at the next local midnight, across the change", () => {
    inNewYork(() => {
      // Shown at 00:30, before the clocks go back at 02:00: the day still has 24.5 hours to run.
      const shown = new Date(2026, 10, 1, 0, 30);
      const midnight = new Date(2026, 10, 2).getTime();
      const state: RevealState = { release: true, firstUseAt: new Date(2026, 9, 1).toISOString(), threads: 20, open: { routines: false, steps: true }, ownDayShownAt: shown.toISOString(), lastShownAt: shown.toISOString() };
      expect(revealAgainAt(state, new Date(2026, 10, 1, 11, 0))).toBe(midnight);
      expect(new Date(midnight).getHours()).toBe(0);
      expect(midnight - shown.getTime()).toBe(24.5 * HOUR);
      // 24 hours after the show, still its day.
      expect(revealNext(state, new Date(2026, 10, 1, 23, 30))).toBeNull();
      expect(revealNext(state, new Date(2026, 10, 2, 0, 30))).toBe("steps");
    });
  });
});

describe("a day of its own", () => {
  const NOW = new Date(2026, 10, 10, 15, 0);
  const state = (over: Partial<RevealState> = {}): RevealState => ({ release: true, firstUseAt: new Date(NOW.getTime() - 10 * DAY).toISOString(), threads: 20, open: { routines: true }, ...over });
  const earlier = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();
  const yesterday = new Date(2026, 10, 9, 20, 0).toISOString();

  test("next on a day nothing else showed, also right after yesterday's dialog", () => {
    expect(revealNext(state(), NOW)).toBe("routines");
    expect(revealNext(state({ lastShownAt: yesterday, dayShownAt: yesterday, asideShownAt: yesterday, tipShownAt: yesterday }), NOW)).toBe("routines");
  });

  for (const [name, stamp] of [
    ["a line dialog", "lastShownAt"],
    ["the agent note", "dayShownAt"],
    ["the star ask or the grill-me tip", "asideShownAt"],
    ["the Sidebar or Launch tip", "tipShownAt"],
  ] as const) {
    test(`never on a local day ${name} took, even hours later; the Checklist behind it may go`, () => {
      expect(revealNext(state({ [stamp]: earlier(5) }), NOW)).toBeNull();
      expect(revealMayClaim("routines", state({ [stamp]: earlier(5) }), NOW)).toBe(false);
      expect(revealNext(state({ [stamp]: earlier(5), open: { routines: true, steps: true } }), NOW)).toBe("steps");
      // The line asks again at midnight.
      expect(revealAgainAt(state({ [stamp]: earlier(5) }), NOW)).toBe(new Date(2026, 10, 11).getTime());
    });
  }

  test("once shown, nothing else that local day: no dialog, no agent note or tip, no star ask; the next day the line goes on", () => {
    const shown = { lastShownAt: earlier(5), dayShownAt: earlier(5), ownDayShownAt: earlier(5) };
    const rest = { routines: false, steps: true, star: true };
    expect(revealNext(state({ ...shown, open: rest }), NOW)).toBeNull();
    expect(revealLineFree("setup", state({ ...shown, open: rest }), NOW)).toBe(false);
    expect(revealAsideNow(state({ ...shown, open: rest }), NOW)).toEqual([]);
    expect(revealAgainAt(state({ ...shown, open: rest }), NOW)).toBe(new Date(2026, 10, 11).getTime());
    const tomorrow = new Date(2026, 10, 11, 9, 0);
    expect(revealNext(state({ ...shown, open: rest }), tomorrow)).toBe("steps");
    expect(revealLineFree("setup", state({ ...shown, open: rest }), tomorrow)).toBe(true);
  });

  test("never on first run (no tenure yet), and a dev build keeps no line", () => {
    expect(revealNext(state({ firstUseAt: earlier(2) }), NOW)).toBeNull();
    expect(revealNext(state({ firstUseAt: null }), NOW)).toBeNull();
    expect(revealNext(state({ release: false }), NOW)).toBeNull();
  });
});
