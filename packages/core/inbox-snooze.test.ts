/**
 * Snooze's rules (approval "inbox-snooze"; core inbox-snooze.ts), shared with
 * Workspaces. What can regress: a menu time off by the hour or the day (Later
 * today's start of hour, Monday's week, a duplicate), a DST day listing a half
 * hour the clocks skip or one twice, today listing a time already past, a
 * return that stays in Quiet or keeps its old time, and a timer past
 * setTimeout's limit firing at once.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { InboxListRow, InboxListSection } from "./inbox-types";
import {
  INBOX_SNOOZE_TIMER_MAX_MS,
  inboxRowAsOf,
  inboxSectionsAsOf,
  inboxSnoozeChoices,
  inboxSnoozeDays,
  inboxSnoozeDelay,
  inboxSnoozeKeepTime,
  inboxSnoozeRefusal,
  inboxSnoozeTimes,
  inboxSnoozeWhen,
} from "./inbox-snooze";

const before = process.env.TZ;
afterEach(() => {
  if (before === undefined) delete process.env.TZ;
  else process.env.TZ = before;
});
const zone = (tz: string) => {
  process.env.TZ = tz;
};
/** A local wall-clock moment in the zone set now. */
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
const ids = (now: Date) => inboxSnoozeChoices(now).map((c) => `${c.id} ${inboxSnoozeWhen(c.until, now)}`);

describe("the menu's times", () => {
  test("Tue 2:40 PM: Later today is 5:00 PM (three hours from the start of the hour), then 8:00 AM mornings and Monday", () => {
    zone("America/New_York");
    expect(ids(local(2026, 11, 3, 14, 40))).toEqual(["later 5:00 PM", "tomorrow Wed 8:00 AM", "days Fri 8:00 AM", "week Mon 8:00 AM"]);
  });

  test("from 6 PM there is no Later today", () => {
    zone("America/New_York");
    expect(ids(local(2026, 11, 3, 17, 59))[0]).toBe("later 8:00 PM");
    expect(ids(local(2026, 11, 3, 18, 0)).map((s) => s.split(" ")[0])).toEqual(["tomorrow", "days", "week"]);
  });

  test("a choice on the same time as one above it is dropped: Friday's In 3 days is Monday, Sunday's Next week is Tomorrow", () => {
    zone("America/New_York");
    expect(ids(local(2026, 11, 6, 9)).map((s) => s.split(" ")[0])).toEqual(["later", "tomorrow", "days"]);
    expect(ids(local(2026, 11, 8, 9)).map((s) => s.split(" ")[0])).toEqual(["later", "tomorrow", "days"]);
  });

  test("on a Monday, Next week is the Monday a week on", () => {
    zone("America/New_York");
    const now = local(2026, 11, 2, 9);
    const week = inboxSnoozeChoices(now).find((c) => c.id === "week")!;
    expect(new Date(week.until).getDate()).toBe(9);
    expect(inboxSnoozeWhen(week.until, now)).toBe("Nov 9, 8:00 AM");
  });

  test("Tomorrow is 8:00 AM local across a DST change, not 24 hours on", () => {
    zone("America/New_York");
    // Spring forward on Sun Mar 8, 2026: Tomorrow from Saturday is 8:00 AM EDT (12:00 UTC), 23 hours away.
    const spring = inboxSnoozeChoices(local(2026, 3, 7, 9)).find((c) => c.id === "tomorrow")!;
    expect(spring.until).toBe("2026-03-08T12:00:00.000Z");
    // Fall back on Sun Nov 1, 2026: 8:00 AM EST is 13:00 UTC.
    const fall = inboxSnoozeChoices(local(2026, 10, 31, 9)).find((c) => c.id === "tomorrow")!;
    expect(fall.until).toBe("2026-11-01T13:00:00.000Z");
  });
});

describe("Pick a time", () => {
  test("today lists only the half hours ahead; today goes when none is left", () => {
    zone("Europe/Berlin");
    const now = local(2026, 11, 3, 14, 40);
    const keys = inboxSnoozeTimes("2026-11-03", now).map((t) => t.key);
    expect(keys[0]).toBe("15:00");
    expect(keys).not.toContain("14:30");
    expect(inboxSnoozeDays(now)[0]).toEqual({ key: "2026-11-03", label: "Today" });
    const late = local(2026, 11, 3, 23, 31);
    expect(inboxSnoozeDays(late)[0]).toEqual({ key: "2026-11-04", label: "Tomorrow" });
    expect(inboxSnoozeDays(late)[1]!.label).toBe("Thu, Nov 5");
  });

  test("the day the clocks skip has no 2:00 or 2:30 AM, and the day they repeat lists 1:00 and 1:30 once", () => {
    zone("America/New_York");
    const now = local(2026, 1, 1, 9);
    const spring = inboxSnoozeTimes("2026-03-08", now).map((t) => t.key);
    expect(spring).not.toContain("02:00");
    expect(spring).not.toContain("02:30");
    expect(spring).toHaveLength(46);
    const fall = inboxSnoozeTimes("2026-11-01", now);
    expect(fall).toHaveLength(48);
    expect(new Set(fall.map((t) => t.until)).size).toBe(48);
    // Every time is the local time it names.
    for (const time of [...inboxSnoozeTimes("2026-03-08", now), ...fall]) {
      const at = new Date(time.until);
      expect(`${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`).toBe(time.key);
    }
  });

  test("a day without the picked time keeps the next one on, else its last", () => {
    zone("America/New_York");
    const now = local(2026, 11, 3, 14, 40);
    const today = inboxSnoozeTimes("2026-11-03", now);
    expect(inboxSnoozeKeepTime(today, "09:00")).toBe("15:00");
    expect(inboxSnoozeKeepTime(inboxSnoozeTimes("2026-03-08", local(2026, 1, 1, 9)), "02:00")).toBe("03:00");
    expect(inboxSnoozeKeepTime([], "09:00")).toBeNull();
  });

  test("a write refuses a time gone by and one past a year", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    expect(inboxSnoozeRefusal("2026-11-03T11:59:59Z", now)).toBe("past");
    expect(inboxSnoozeRefusal("2028-01-01T00:00:00Z", now)).toBe("far");
    expect(inboxSnoozeRefusal("soon", now)).toBe("invalid");
    expect(inboxSnoozeRefusal("2026-11-04T08:00:00Z", now)).toBeNull();
  });
});

function row(id: string, over: Partial<InboxListRow>): InboxListRow {
  return { thread_id: id, section: "quiet", unread: false, last_at: "2026-11-01T10:00:00.000Z", resolved_at: null, snoozed: null, ...over } as InboxListRow;
}

describe("the return", () => {
  const until = "2026-11-04T13:00:00.000Z";
  const at = "2026-11-03T12:00:00.000Z";

  test("a running snooze leaves the row as it is", () => {
    const r = row("msg_a", { snoozed: { until, at } });
    expect(inboxRowAsOf(r, new Date("2026-11-04T12:59:59Z"))).toBe(r);
  });

  test("past its time: back in its own section, a Quiet one as New, bold, with the return as its time", () => {
    const now = new Date("2026-11-04T13:00:01Z");
    expect(inboxRowAsOf(row("msg_a", { snoozed: { until, at } }), now)).toMatchObject({ section: "new", unread: true, last_at: until, snooze_back: until, snoozed: null });
    expect(inboxRowAsOf(row("msg_b", { section: "stopped", unread: true, snoozed: { until, at } }), now).section).toBe("stopped");
    // A message after the return keeps its own, later time.
    expect(inboxRowAsOf(row("msg_c", { last_at: "2026-11-04T14:00:00.000Z", snoozed: { until, at } }), new Date("2026-11-04T15:00:00Z")).last_at).toBe("2026-11-04T14:00:00.000Z");
  });

  test("an archived thread stays archived", () => {
    const r = row("msg_a", { resolved_at: at, snoozed: { until, at } });
    expect(inboxRowAsOf(r, new Date("2026-11-05T00:00:00Z"))).toBe(r);
  });

  test("the window's clock moves a returned row from the band to the top of its section", () => {
    const sections: InboxListSection[] = [
      { id: "new", label: "New", threads: [row("msg_old", { section: "new", last_at: "2026-11-04T10:00:00.000Z" })] },
      { id: "quiet", label: "Quiet", threads: [] },
    ];
    const band = [row("msg_back", { snoozed: { until, at } }), row("msg_later", { snoozed: { until: "2026-11-09T13:00:00.000Z", at } })];
    const out = inboxSectionsAsOf(sections, band, new Date("2026-11-04T13:05:00Z"));
    expect(out.sections[0]!.threads.map((r) => r.thread_id)).toEqual(["msg_back", "msg_old"]);
    expect(out.snoozed.map((r) => r.thread_id)).toEqual(["msg_later"]);
  });
});

describe("the timer", () => {
  test("waits for the nearest snooze still ahead, never past setTimeout's limit", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    expect(inboxSnoozeDelay(["2026-11-03T11:00:00Z", "2026-11-03T12:00:05Z", "2026-11-03T13:00:00Z"], now)).toBe(5000);
    expect(inboxSnoozeDelay(["2026-11-03T11:00:00Z"], now)).toBeNull();
    expect(inboxSnoozeDelay(["2027-06-01T00:00:00Z"], now)).toBe(INBOX_SNOOZE_TIMER_MAX_MS);
  });
});
