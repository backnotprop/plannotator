/**
 * Plannotator Inbox: snoozing a thread (approval "inbox-snooze",
 * .product/approved/inbox-snooze/). Pure, and shared with Workspaces: the
 * times the menu offers, the day and half-hour lists of Pick a time, and the
 * one rule for whether a thread is snoozed.
 *
 * A snooze is `until` (absolute UTC) against the clock of whoever reads it, at
 * the moment they read it, so it is right after a sleep or a restart and for a
 * linked machine that is asleep. Every day and time here is the person's local
 * time: a date built from local parts, so 8:00 AM stays 8:00 AM across a
 * daylight saving change, and a half hour the change skips is not offered.
 */

import { inboxRowArchived, type InboxListRow, type InboxListSection } from "./inbox-types";

/** A thread's snooze, on its list row: when it comes back, and when it was snoozed. */
export interface InboxRowSnooze {
  /** ISO, UTC. */
  until: string;
  at: string;
}

/** One entry of `inbox/snoozes.json`. */
export interface InboxSnooze extends InboxRowSnooze {
  thread_id: string;
}

/** The furthest ahead a snooze may be set (a bound on a request, wider than Pick a time's list). */
export const INBOX_SNOOZE_MAX_DAYS = 366;
/** How many days Pick a time lists. */
export const INBOX_SNOOZE_DAYS = 60;
/** The longest delay `setTimeout` takes: past it the timer fires at once. */
export const INBOX_SNOOZE_TIMER_MAX_MS = 2 ** 31 - 1;
/** The Snoozed band under Quiet, in the list the window draws. Not a section a row is placed in. */
export const INBOX_SNOOZED_BAND = { id: "snoozed", label: "Snoozed" } as const;

const LATER_TODAY_HOURS = 3;
/** From this hour (6 PM) Later today is gone: three hours on is the night. */
const LATER_TODAY_LAST_HOUR = 18;
const MORNING_HOUR = 8;
const PICK_DAYS_OUT = 2;
const PICK_HOUR = 15;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** Local midnight (or the day's first moment where midnight does not exist), `days` on. */
const dayOf = (date: Date, days = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const morningOf = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, MORNING_HOUR);

function clock(date: Date): string {
  const hours = date.getHours();
  return `${hours % 12 || 12}:${pad(date.getMinutes())} ${hours < 12 ? "AM" : "PM"}`;
}

/** "5:00 PM" today, "Wed 8:00 AM" within the week, "Nov 12, 8:00 AM" further on. */
export function inboxSnoozeWhen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (sameDay(date, now)) return clock(date);
  const days = Math.round((dayOf(date).getTime() - dayOf(now).getTime()) / 86_400_000);
  if (days > 0 && days < 7) return `${WEEKDAYS[date.getDay()]} ${clock(date)}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${clock(date)}`;
}

export type InboxSnoozeChoiceId = "later" | "tomorrow" | "days" | "week";

export interface InboxSnoozeChoice {
  id: InboxSnoozeChoiceId;
  label: string;
  until: string;
}

/**
 * The menu's times. Later today: three hours from the start of this hour, gone
 * from 6 PM. Tomorrow and In 3 days: 8:00 AM. Next week: Monday 8:00 AM, a
 * full week on when today is Monday. A choice that lands on the time of one
 * above it is dropped (a Friday's In 3 days is Monday; a Sunday's Next week is
 * Tomorrow).
 */
export function inboxSnoozeChoices(now: Date = new Date()): InboxSnoozeChoice[] {
  const choices: { id: InboxSnoozeChoiceId; label: string; when: Date }[] = [];
  if (now.getHours() < LATER_TODAY_LAST_HOUR) {
    choices.push({ id: "later", label: "Later today", when: new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + LATER_TODAY_HOURS) });
  }
  choices.push({ id: "tomorrow", label: "Tomorrow", when: morningOf(now, 1) });
  choices.push({ id: "days", label: "In 3 days", when: morningOf(now, 3) });
  choices.push({ id: "week", label: "Next week", when: morningOf(now, (8 - now.getDay()) % 7 || 7) });
  const seen = new Set<number>();
  return choices.flatMap(({ id, label, when }) => {
    if (seen.has(when.getTime())) return [];
    seen.add(when.getTime());
    return [{ id, label, until: when.toISOString() }];
  });
}

/** A day in Pick a time's list. */
export interface InboxSnoozeDay {
  /** "2026-11-05", local. */
  key: string;
  label: string;
}

/** A half hour in Pick a time's list. */
export interface InboxSnoozeTime {
  /** "15:30", local. */
  key: string;
  label: string;
  until: string;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDayKey(key: string): [number, number, number] {
  const [year, month, day] = key.split("-").map(Number);
  return [year!, month! - 1, day!];
}

/**
 * The half hours left on a day: every local time that exists that day and has
 * not passed. A time the clocks skip is absent, and a time they repeat is
 * listed once (the first).
 */
export function inboxSnoozeTimes(key: string, now: Date = new Date()): InboxSnoozeTime[] {
  const [year, month, day] = parseDayKey(key);
  const out: InboxSnoozeTime[] = [];
  for (let half = 0; half < 48; half += 1) {
    const hours = Math.floor(half / 2);
    const minutes = half % 2 ? 30 : 0;
    const date = new Date(year, month, day, hours, minutes);
    if (date.getHours() !== hours || date.getMinutes() !== minutes || date.getTime() <= now.getTime()) continue;
    out.push({ key: `${pad(hours)}:${pad(minutes)}`, label: clock(date), until: date.toISOString() });
  }
  return out;
}

/** Pick a time's days, today first: "Today", "Tomorrow", then "Thu, Nov 5". Today goes when no half hour is left in it. */
export function inboxSnoozeDays(now: Date = new Date(), count: number = INBOX_SNOOZE_DAYS): InboxSnoozeDay[] {
  const out: InboxSnoozeDay[] = [];
  for (let days = 0; days < count; days += 1) {
    const date = dayOf(now, days);
    const key = dayKey(date);
    if (days === 0 && inboxSnoozeTimes(key, now).length === 0) continue;
    out.push({ key, label: days === 0 ? "Today" : days === 1 ? "Tomorrow" : `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}` });
  }
  return out;
}

/** Where Pick a time opens: past what the menu's own times reach, two days out at 3:00 PM. */
export function inboxSnoozeFirstPick(now: Date = new Date()): { day: string; time: string } {
  return { day: dayKey(dayOf(now, PICK_DAYS_OUT)), time: `${pad(PICK_HOUR)}:00` };
}

/**
 * The picked time on a newly picked day: the same one, or, when that day does
 * not have it (past already today, or skipped by the clocks), the next one on
 * from it, else the day's last.
 */
export function inboxSnoozeKeepTime(times: readonly InboxSnoozeTime[], time: string): string | null {
  return (times.find((entry) => entry.key >= time) ?? times[times.length - 1])?.key ?? null;
}

/** The one rule: a snooze runs while `until` is ahead of the reader's clock. */
export function inboxSnoozeRunning(until: string, now: Date = new Date()): boolean {
  return Date.parse(until) > now.getTime();
}

/** Why a write's `until` is refused, or null. */
export function inboxSnoozeRefusal(until: unknown, now: Date = new Date()): "invalid" | "past" | "far" | null {
  if (typeof until !== "string") return "invalid";
  const at = Date.parse(until);
  if (Number.isNaN(at)) return "invalid";
  if (at <= now.getTime()) return "past";
  return at > now.getTime() + INBOX_SNOOZE_MAX_DAYS * 86_400_000 ? "far" : null;
}

/** The row is snoozed now, by the reader's clock. */
export function inboxRowSnoozed(row: Pick<InboxListRow, "snoozed">, now: Date = new Date()): boolean {
  return !!row.snoozed && inboxSnoozeRunning(row.snoozed.until, now);
}

/**
 * The row as it stands by `now`. A snooze still running leaves it as it is. A
 * snooze past its time is a return, drawn from the list's own rule and never
 * from the store: back in its own section (a Quiet thread comes back as New,
 * so a snooze is also a reminder), bold, with the return time as its time and
 * `snooze_back` for the small clock, until the person reads it. An archived
 * thread stays archived.
 */
export function inboxRowAsOf(row: InboxListRow, now: Date = new Date()): InboxListRow {
  if (!row.snoozed || inboxSnoozeRunning(row.snoozed.until, now) || inboxRowArchived(row)) return row;
  const { until } = row.snoozed;
  return {
    ...row,
    snoozed: null,
    snooze_back: until,
    unread: true,
    section: row.section === "quiet" ? "new" : row.section,
    last_at: until > row.last_at ? until : row.last_at,
  };
}

/** Soonest back first (the band's order); ties on the thread id. */
function soonestFirst(left: InboxListRow, right: InboxListRow): number {
  return Date.parse(left.snoozed?.until ?? "") - Date.parse(right.snoozed?.until ?? "") || left.thread_id.localeCompare(right.thread_id);
}

/** Rows into what the list shows by `now`: those still snoozed apart, soonest first; the others as they stand. */
export function inboxSplitSnoozed(rows: readonly InboxListRow[], now: Date = new Date()): { rows: InboxListRow[]; snoozed: InboxListRow[] } {
  const listed: InboxListRow[] = [];
  const snoozed: InboxListRow[] = [];
  for (const row of rows) {
    const asOf = inboxRowAsOf(row, now);
    (inboxRowSnoozed(asOf, now) ? snoozed : listed).push(asOf);
  }
  return { rows: listed, snoozed: snoozed.sort(soonestFirst) };
}

/**
 * The window's own clock over a list it read (a list carries `snoozed` apart
 * from its sections, `?snoozed=exclude`): a row past its time leaves the band
 * for its section, at its place there (newest first, the list's own order).
 */
export function inboxSectionsAsOf(sections: readonly InboxListSection[], snoozed: readonly InboxListRow[], now: Date = new Date()): { sections: InboxListSection[]; snoozed: InboxListRow[] } {
  const split = inboxSplitSnoozed(snoozed, now);
  if (split.rows.length === 0) return { sections: sections.map((section) => ({ ...section })), snoozed: split.snoozed };
  return {
    snoozed: split.snoozed,
    sections: sections.map((section) => {
      const back = split.rows.filter((row) => row.section === section.id);
      if (back.length === 0) return { ...section };
      return {
        ...section,
        threads: [...section.threads, ...back].sort((left, right) => right.last_at.localeCompare(left.last_at) || left.thread_id.localeCompare(right.thread_id)),
      };
    }),
  };
}

/**
 * How long until the nearest snooze still ahead is over, in milliseconds, or
 * null when none is ahead. Held under `setTimeout`'s limit, so a snooze months
 * away wakes the timer early (a timer re-arms itself) rather than at once.
 */
export function inboxSnoozeDelay(untils: Iterable<string>, now: Date = new Date()): number | null {
  let nearest = Number.POSITIVE_INFINITY;
  for (const until of untils) {
    const left = Date.parse(until) - now.getTime();
    if (left > 0 && left < nearest) nearest = left;
  }
  return nearest === Number.POSITIVE_INFINITY ? null : Math.min(nearest, INBOX_SNOOZE_TIMER_MAX_MS);
}
