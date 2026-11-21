import { describe, expect, test } from "bun:test";
import { inboxScheduledDecide, inboxScheduledNext, inboxScheduledPreview, inboxScheduleRefusal, inboxScheduleWords, routineLineText } from "./inbox-scheduled";

const NY = "America/New_York";
const at = (iso: string) => new Date(iso);
const daily = { cron: "0 9 * * *", tz: NY };
const hourly = { cron: "0 * * * *", tz: NY };

describe("the missed-run decision (spec section 4)", () => {
  // 2026-11-16 is a Monday; 9:00 AM EST is 14:00Z.
  test("a daily over a closed lid (due 9:00, opened 11:14): run once late, or skip", () => {
    const base = { schedule: daily, handled_through: "2026-11-15T14:00:00.000Z", now: at("2026-11-16T16:14:00Z"), why: "asleep" as const, running: false };
    expect(inboxScheduledDecide({ ...base, if_missed: "run_once" })).toEqual({ kind: "run", due_at: "2026-11-16T14:00:00.000Z", late: true, missed_before: 0, handled_through: "2026-11-16T14:00:00.000Z" });
    expect(inboxScheduledDecide({ ...base, if_missed: "skip" })).toMatchObject({ kind: "skip", count: 1, reason: "asleep", handled_through: "2026-11-16T14:00:00.000Z" });
  });

  test("an hourly closed over five runs: one run for the newest, never five", () => {
    const base = { schedule: hourly, handled_through: "2026-11-16T13:00:00.000Z", now: at("2026-11-16T18:40:00Z"), why: "asleep" as const, running: false };
    expect(inboxScheduledDecide({ ...base, if_missed: "run_once" })).toMatchObject({ kind: "run", due_at: "2026-11-16T18:00:00.000Z", late: true, missed_before: 4 });
    expect(inboxScheduledDecide({ ...base, if_missed: "skip" })).toEqual({
      kind: "skip",
      count: 5,
      from: "2026-11-16T14:00:00.000Z",
      to: "2026-11-16T18:00:00.000Z",
      reason: "asleep",
      handled_through: "2026-11-16T18:00:00.000Z",
    });
  });

  test("the lid opens at 8:58 with the next run at 9:00: no late run, either setting", () => {
    for (const if_missed of ["run_once", "skip"] as const) {
      const decision = inboxScheduledDecide({ schedule: daily, if_missed, handled_through: "2026-11-15T14:00:00.000Z", now: at("2026-11-17T13:58:00Z"), why: "not_running", running: false });
      expect(decision).toMatchObject({ kind: "skip", count: 1, to: "2026-11-16T14:00:00.000Z", reason: "not_running" });
    }
  });

  test("a one-time run whose time passed: runs once late, or is skipped", () => {
    const once = { at: "2026-11-20T17:00", tz: NY };
    const base = { schedule: once, handled_through: "2026-11-19T00:00:00.000Z", now: at("2026-11-21T15:00:00Z"), why: "not_running" as const, running: false };
    expect(inboxScheduledDecide({ ...base, if_missed: "run_once" })).toMatchObject({ kind: "run", due_at: "2026-11-20T22:00:00.000Z", late: true });
    expect(inboxScheduledDecide({ ...base, if_missed: "skip" })).toMatchObject({ kind: "skip", count: 1, reason: "not_running" });
    expect(inboxScheduledDecide({ ...base, if_missed: "run_once", handled_through: "2026-11-20T22:00:00.000Z" })).toEqual({ kind: "wait" });
  });

  test("late with the Inbox up and awake: skip says it couldn't start on time, not that the next run was close", () => {
    const base = { schedule: daily, handled_through: "2026-11-15T14:00:00.000Z", now: at("2026-11-16T14:05:00Z"), why: null, running: false };
    expect(inboxScheduledDecide({ ...base, if_missed: "skip" })).toMatchObject({ kind: "skip", reason: "late" });
    expect(inboxScheduledDecide({ ...base, if_missed: "run_once" })).toMatchObject({ kind: "run", late: true });
    // The next run under 15 minutes away is that reason, either setting.
    const close = { ...base, schedule: { cron: "0,20 9 * * *", tz: NY }, now: at("2026-11-16T14:06:00Z") };
    for (const if_missed of ["run_once", "skip"] as const) expect(inboxScheduledDecide({ ...close, if_missed })).toMatchObject({ kind: "skip", reason: "missed" });
  });

  test("on time, a run still going, nothing due", () => {
    const base = { schedule: daily, if_missed: "run_once" as const, handled_through: "2026-11-15T14:00:00.000Z", why: null, running: false };
    expect(inboxScheduledDecide({ ...base, now: at("2026-11-16T14:00:20Z") })).toMatchObject({ kind: "run", late: false, missed_before: 0 });
    expect(inboxScheduledDecide({ ...base, now: at("2026-11-16T14:00:20Z"), running: true })).toMatchObject({ kind: "skip", count: 1, reason: "still_running" });
    expect(inboxScheduledDecide({ ...base, now: at("2026-11-16T13:59:00Z") })).toEqual({ kind: "wait" });
    expect(inboxScheduledDecide({ ...base, schedule: null, now: at("2026-11-16T14:00:20Z") })).toEqual({ kind: "wait" });
  });

  test("ten years away is one decision for the newest due time, counted up to 1,000, not a walk over each", () => {
    const base = { schedule: { cron: "*/15 * * * *", tz: NY }, handled_through: "2016-11-16T14:00:00.000Z", now: at("2026-11-16T14:07:00Z"), why: "not_running" as const, running: false };
    expect(inboxScheduledDecide({ ...base, if_missed: "skip" })).toEqual({ kind: "skip", count: 1000, from: "2016-11-16T14:15:00.000Z", to: "2026-11-16T14:00:00.000Z", reason: "not_running", handled_through: "2026-11-16T14:00:00.000Z" });
    expect(inboxScheduledDecide({ ...base, if_missed: "run_once", now: at("2026-11-16T14:01:00Z") })).toMatchObject({ kind: "run", due_at: "2026-11-16T14:00:00.000Z", missed_before: 999 });
  });
});

describe("next run across daylight saving", () => {
  test("New York: 2:30 AM on spring-forward night runs at 3:00; 1:30 AM on fall-back night runs once", () => {
    expect(inboxScheduledNext({ cron: "30 2 * * *", tz: NY }, at("2026-03-07T12:00:00Z"))?.toISOString()).toBe("2026-03-08T07:00:00.000Z");
    const fall = { cron: "30 1 * * *", tz: NY };
    const first = inboxScheduledNext(fall, at("2026-10-31T12:00:00Z"))!;
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(inboxScheduledNext(fall, first)?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("Berlin keeps 9:00 AM local across its own change", () => {
    const berlin = { cron: "0 9 * * *", tz: "Europe/Berlin" };
    expect(inboxScheduledNext(berlin, at("2026-03-28T12:00:00Z"))?.toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(inboxScheduledNext(berlin, at("2026-10-24T12:00:00Z"))?.toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });
});

describe("the 15-minute rule", () => {
  test("every preset passes; a cron under 15 minutes apart is refused with the editor's words", () => {
    for (const cron of ["0 * * * *", "0 9 * * *", "0 9 * * 1-5", "0 17 * * 5", "*/15 * * * *"]) expect(inboxScheduleRefusal({ cron, tz: NY })).toBeNull();
    expect(inboxScheduleRefusal({ cron: "*/5 * * * *", tz: NY })).toEqual({
      code: "schedule_too_frequent",
      every_minutes: 5,
      error: "Scheduled times are at least 15 minutes apart. This one runs every 5 minutes.",
    });
    // Two runs close together once a day are refused too.
    expect(inboxScheduleRefusal({ cron: "0,10 9 * * *", tz: NY })?.every_minutes).toBe(10);
  });

  test("what does not parse is refused in our own words, never the cron library's, and the preview has no next run", () => {
    const cron = { code: "schedule_invalid", error: "That isn't a schedule Plannotator can read. A schedule is a 5-field cron, such as 0 9 * * 1-5." };
    expect(inboxScheduleRefusal({ cron: "61 * * * *", tz: NY })).toEqual(cron);
    expect(inboxScheduleRefusal({ cron: "*/5 * * * * *", tz: NY })).toEqual(cron);
    expect(inboxScheduleRefusal({ cron: "0 9 * * *", tz: "Mars/Olympus" })).toEqual({
      code: "schedule_invalid",
      error: "That isn't a schedule Plannotator can read. Mars/Olympus isn't a time zone it knows; use one such as America/New_York.",
    });
    expect(inboxScheduledPreview({ cron: "*/5 * * * *", tz: NY }, at("2026-11-16T00:00:00Z"))).toMatchObject({ ok: false, next_run: null, refused: { code: "schedule_too_frequent" } });
  });

  test("*/14 runs 14 minutes apart but 4 at the hour's end: the refusal says it can run 4 apart, not every 4", () => {
    expect(inboxScheduleRefusal({ cron: "*/14 * * * *", tz: NY })).toMatchObject({ every_minutes: 4, error: "Scheduled times are at least 15 minutes apart. This one can run 4 minutes apart." });
  });

  test("a date the calendar does not have, and a cron that never comes round, are refused", () => {
    expect(inboxScheduleRefusal({ at: "2026-02-30T10:00", tz: NY })).toMatchObject({ code: "schedule_invalid", error: expect.stringContaining("2026-02-30") });
    expect(inboxScheduleRefusal({ at: "2026-11-20T24:00", tz: NY })?.code).toBe("schedule_invalid");
    expect(inboxScheduleRefusal({ cron: "0 9 31 2 *", tz: NY })).toEqual({ code: "schedule_invalid", error: "That schedule never runs: no day matches it." });
  });

  test("a one-time time already passed is refused when it is set, and its preview says so", () => {
    const now = at("2026-11-21T12:00:00Z");
    expect(inboxScheduleRefusal({ at: "2026-11-20T17:00", tz: NY }, now)).toEqual({ code: "schedule_invalid", error: "That time has already passed." });
    expect(inboxScheduleRefusal({ at: "2026-11-22T17:00", tz: NY }, now)).toBeNull();
    expect(inboxScheduledPreview({ at: "2026-11-20T17:00", tz: NY }, now)).toMatchObject({ ok: false, refused: { error: "That time has already passed." } });
  });
});

test("the presets in words", () => {
  expect(inboxScheduleWords({ cron: "0 9 * * 1-5", tz: NY })).toBe("Every weekday at 9:00 AM");
  expect(inboxScheduleWords({ cron: "0 17 * * 5", tz: NY })).toBe("Every week on Friday at 5:00 PM");
  expect(inboxScheduleWords({ cron: "0 */2 * * *", tz: NY })).toBe("Every 2 hours, at minute 0");
  expect(inboxScheduleWords({ at: "2026-11-20T17:00", tz: NY })).toBe("Once on Fri, Nov 20 at 5:00 PM");
  expect(inboxScheduleWords(null)).toBe("Runs when you run it.");
});

test("a step that does not divide the hour or the day says what it does, never an untrue every", () => {
  expect(inboxScheduleWords({ cron: "*/45 * * * *", tz: NY })).toBe("Every hour at :00 and :45");
  expect(inboxScheduleWords({ cron: "*/20 * * * *", tz: NY })).toBe("Every 20 minutes");
  expect(inboxScheduleWords({ cron: "0 */5 * * *", tz: NY })).toBe("On the schedule 0 */5 * * *");
});

describe("a routine's name or folder in a change line", () => {
  // The lines as packages/server/inbox-scheduled.ts writes them; the wording is main's (packages/server/inbox-scheduled-server.test.ts).
  const made = (name: string, on = false) =>
    `Made the routine [${routineLineText(name.replace(/[[\]]/g, ""))}](#routine=sch_1). ${on ? "It is on, as you asked with /create-routine." : "It is off until you turn it on."}`;

  test("a plain name or folder is written as it always was, with no code marks", () => {
    expect(made("Morning triage")).toBe("Made the routine [Morning triage](#routine=sch_1). It is off until you turn it on.");
    expect(made("Not theirs")).toBe("Made the routine [Not theirs](#routine=sch_1). It is off until you turn it on.");
    expect(made("Dependency check", true)).toBe("Made the routine [Dependency check](#routine=sch_1). It is on, as you asked with /create-routine.");
    expect(`Its name was ${routineLineText("Morning triage")}.`).toBe("Its name was Morning triage.");
    expect(made("Maya's triage")).toBe("Made the routine [Maya's triage](#routine=sch_1). It is off until you turn it on.");
    expect(`Deleted the routine ${routineLineText("Maya's triage")}. Its thread and past runs stay.`).toBe("Deleted the routine Maya's triage. Its thread and past runs stay.");
    expect(`It now works in ${routineLineText("~/acme-web", "path")} (was ${routineLineText("~/acme-api", "path")}).`).toBe("It now works in ~/acme-web (was ~/acme-api).");
    for (const name of [
      ".,’-–—()+?", // only the allowed punctuation
      "Weekly sync v2.1",
      "follow-up (daily)",
      "What changed?",
      "🚀 Deploy check",
      "👨‍👩‍👧 family 👍🏽 🇯🇵",
      "Café crème",
      "Cafe\u0301 (decomposed)",
      "毎朝のトリアージ",
      "हिन्दी रिपोर्ट",
      "فرز يومي",
    ]) expect(routineLineText(name)).toBe(name);
    for (const folder of ["~/code/my-app_v2", "/srv/apps/acme web", "~/projects/snake__case", "~/linear/ENG-42", "~/maya's app"]) expect(routineLineText(folder, "path")).toBe(folder);
  });

  test("a name or folder any renderer could read as markup, or not as typed, is code", () => {
    for (const name of [
      'Say "hi"',
      "www.example.com",
      "Check WWW.example.com",
      " leading space",
      "trailing space ",
      "two\nlines",
      "tab\there",
      "no\u00a0break",
      "\u202eevil", // a right-to-left override
      "a\u2066b", // a direction isolate
      "\u3164", // a Hangul filler: a letter that draws nothing
      "Triage\u115F", // a filler inside a name
      "a\u034Fb", // a combining grapheme joiner
      "x\uFE00", // a variation selector with no emoji
      "\u0301\u0301", // only combining marks
      "a \u0301b", // a mark with no letter under it
      "\u200D", // only a joiner
      "Wait...",
      "a..b",
      "a--b",
      "ENG-42 follow-up", // the window links a Linear issue
      "Maya's ENG-42",
      "@maya's sweep",
      "snake_case",
      "~tilde~",
      "a/b",
      "Fix #123",
      "@maya",
      "x = 1",
      "a | b",
      "$5",
      "a & b",
      "back\\slash",
      ":rocket:",
    ]) expect([name, routineLineText(name).startsWith("`")]).toEqual([name, true]);
    for (const folder of ["~/code/next.js", "~/.config/app", "~/_drafts", "~/a~b", "~/x/ _y", "~/é_x_", "C:\\Users\\maya", "~/notes ENG-42"]) {
      expect([folder, routineLineText(folder, "path").startsWith("`")]).toEqual([folder, true]);
    }
    // The fence outgrows any run of backticks in the text.
    expect(routineLineText("a `b` c")).toBe("``a `b` c``");
    expect(routineLineText("`x`")).toBe("`` `x` ``");
  });
});
