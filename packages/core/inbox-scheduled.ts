/**
 * Scheduled threads, the pure part: the next-run math (croner, which knows time zones), the 15-minute rule, a
 * schedule in plain words, and the clock's one decision per check (run, skip or wait). Time always comes in as an
 * argument. Browser-safe, so the window can show the next run as the person edits.
 */
import { Cron } from "croner";
import type { InboxScheduledIfMissed, InboxScheduledPreview, InboxScheduledSchedule, InboxScheduledSkipReason } from "./inbox-scheduled-types";

/** The one limit (the owner, "At least 15 minutes apart, like Conductor"). */
export const SCHEDULED_MIN_GAP_MINUTES = 15;
/** A run that starts later than this after its due time is late (it changes the words only). */
export const SCHEDULED_LATE_MS = 2 * 60_000;
/** How often the clock checks. */
export const SCHEDULED_TICK_MS = 30_000;

const MINUTE = 60_000;
/** How many coming runs the 15-minute check looks at: enough to meet any pattern's closest pair at least once. */
const GAP_SAMPLE = 500;

export type InboxScheduledRefusal = { code: "schedule_too_frequent" | "schedule_invalid"; error: string; every_minutes?: number };

const cronOf = (schedule: NonNullable<InboxScheduledSchedule>): Cron =>
  "cron" in schedule ? new Cron(schedule.cron, { timezone: schedule.tz, mode: "5-part" }) : new Cron(atText(schedule.at), { timezone: schedule.tz });

/** A one-time `at` as croner reads a wall time in its zone: `YYYY-MM-DDTHH:MM[:SS]`, no offset. */
const atText = (at: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(at)) throw new Error("a one-time schedule is a date and time, 2026-11-20T17:00");
  return at.length === 16 ? `${at}:00` : at;
};

/** Why a schedule is refused, or null. The words are the editor's and an agent's alike. */
export function inboxScheduleRefusal(schedule: InboxScheduledSchedule): InboxScheduledRefusal | null {
  if (schedule === null) return null;
  let cron: Cron;
  try {
    cron = cronOf(schedule);
    cron.nextRun(new Date(0));
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/^Cron\w*: /, "").split(". Original error")[0]!;
    return { code: "schedule_invalid", error: `That isn't a schedule: ${reason}.` };
  }
  if (!("cron" in schedule)) return null;
  const runs = cron.nextRuns(GAP_SAMPLE, new Date(Date.UTC(2026, 0, 1)));
  let gap = Infinity;
  for (let i = 1; i < runs.length; i++) gap = Math.min(gap, runs[i]!.getTime() - runs[i - 1]!.getTime());
  if (gap >= SCHEDULED_MIN_GAP_MINUTES * MINUTE) return null;
  const every = Math.max(1, Math.round(gap / MINUTE));
  return {
    code: "schedule_too_frequent",
    every_minutes: every,
    error: `Scheduled threads run at least ${SCHEDULED_MIN_GAP_MINUTES} minutes apart. This one runs every ${every === 1 ? "minute" : `${every} minutes`}.`,
  };
}

/** The first due time after `after`, or null (no schedule, a one-time one that passed, or a schedule that is refused). */
export function inboxScheduledNext(schedule: InboxScheduledSchedule, after: Date): Date | null {
  if (schedule === null) return null;
  try {
    return cronOf(schedule).nextRun(after);
  } catch {
    return null;
  }
}

/** The due times in (`after`, `through`], oldest first. */
export function inboxScheduledDue(schedule: InboxScheduledSchedule, after: Date, through: Date): Date[] {
  const out: Date[] = [];
  for (let next = inboxScheduledNext(schedule, after); next && next.getTime() <= through.getTime(); next = inboxScheduledNext(schedule, next)) out.push(next);
  return out;
}

// ─── Words ───

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const clock = (hour: number, minute: number): string => `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;

const listed = (words: string[]): string => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/** A cron in plain words, for the patterns people write; any other reads as itself. */
function cronWords(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `On the schedule ${cron}`;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const num = (text: string) => (/^\d+$/.test(text) ? Number(text) : null);
  const m = num(min);
  const h = num(hour);
  const everyDay = dom === "*" && month === "*";
  if (everyDay && dow === "*") {
    const stepMin = /^\*\/(\d+)$/.exec(min);
    if (stepMin && hour === "*") return `Every ${stepMin[1]} minutes`;
    if (m !== null && hour === "*") return `Every hour at :${String(m).padStart(2, "0")}`;
    const stepHour = /^\*\/(\d+)$/.exec(hour);
    if (m !== null && stepHour) return `Every ${stepHour[1]} hours, at minute ${m}`;
    if (m !== null && h !== null) return `Every day at ${clock(h, m)}`;
  }
  if (everyDay && m !== null && h !== null) {
    if (dow === "1-5") return `Every weekday at ${clock(h, m)}`;
    if (dow === "0,6" || dow === "6,0") return `Every weekend day at ${clock(h, m)}`;
    if (/^[0-7](,[0-7])*$/.test(dow)) {
      const days = [...new Set(dow.split(",").map((d) => DAYS[Number(d) % 7]!))];
      return days.length === 1 ? `Every week on ${days[0]} at ${clock(h, m)}` : `Every ${listed(days)} at ${clock(h, m)}`;
    }
  }
  if (m !== null && h !== null && month === "*" && dow === "*" && /^\d+$/.test(dom)) return `Every month on day ${dom} at ${clock(h, m)}`;
  return `On the schedule ${cron}`;
}

/** "Every weekday at 9:00 AM", "Once on Fri, Nov 20 at 5:00 PM", "Runs when you run it." */
export function inboxScheduleWords(schedule: InboxScheduledSchedule): string {
  if (schedule === null) return "Runs when you run it.";
  if ("cron" in schedule) return cronWords(schedule.cron);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(schedule.at);
  if (!match) return `Once on ${schedule.at}`;
  const [, y, mo, d, h, mi] = match.map(Number) as number[];
  // The wall date's own weekday and month name, read in UTC so no zone moves the day.
  const day = new Date(Date.UTC(y!, mo! - 1, d!)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  return `Once on ${day} at ${clock(h!, mi!)}`;
}

/** The zone's short name at `at` ("EST", "CET", else its offset "GMT+5:30"). */
export function inboxScheduledTzShort(tz: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

/** A time as a run's words say it, in the schedule's zone: "Mon 9:00 AM". */
export function inboxScheduledWhen(at: Date, tz: string): string {
  const options: Intl.DateTimeFormatOptions = { weekday: "short", hour: "numeric", minute: "2-digit" };
  try {
    return at.toLocaleString("en-US", { ...options, timeZone: tz });
  } catch {
    return at.toLocaleString("en-US", options);
  }
}

/** The line a late run's prompt ends with. */
export function inboxScheduledLateLine(due: Date, started: Date, tz: string): string {
  return `This run was due ${inboxScheduledWhen(due, tz)} and started ${inboxScheduledWhen(started, tz)}.`;
}

/** The preview the editor shows as the person edits (`POST /api/inbox/scheduled/preview`). */
export function inboxScheduledPreview(schedule: InboxScheduledSchedule, now: Date): InboxScheduledPreview {
  const refused = inboxScheduleRefusal(schedule);
  const next = refused ? null : inboxScheduledNext(schedule, now);
  return {
    ok: refused === null,
    schedule_words: inboxScheduleWords(schedule),
    tz_short: schedule ? inboxScheduledTzShort(schedule.tz, next ?? now) : null,
    next_run: next ? next.toISOString() : null,
    ...(refused ? { refused } : {}),
  };
}

// ─── The clock's decision ───

export type InboxScheduledDecision =
  | { kind: "wait" }
  | { kind: "run"; due_at: string; late: boolean; missed_before: number; handled_through: string }
  | { kind: "skip"; count: number; from: string; to: string; reason: InboxScheduledSkipReason; handled_through: string };

/**
 * One check for one scheduled thread that is on (spec appendix B): the due times since `handled_through`; none:
 * wait. The newest one under 2 minutes old: run it on time (earlier ones it folds in count as missed). Older: missed,
 * and `if_missed` decides; a late run never comes when the next on-time run is under 15 minutes away. A run still
 * going skips it. At most one run or one skip per check, never a burst. `why`: what kept it from running on time
 * (`not_running` at the Inbox's start, `asleep` after a check that came late).
 */
export function inboxScheduledDecide(input: {
  schedule: InboxScheduledSchedule;
  if_missed: InboxScheduledIfMissed;
  handled_through: string | null;
  now: Date;
  why: "asleep" | "not_running" | null;
  running: boolean;
}): InboxScheduledDecision {
  if (input.schedule === null || input.handled_through === null) return { kind: "wait" };
  const due = inboxScheduledDue(input.schedule, new Date(input.handled_through), input.now);
  const newest = due.at(-1);
  if (!newest) return { kind: "wait" };
  const handled_through = newest.toISOString();
  const skip = (reason: InboxScheduledSkipReason): InboxScheduledDecision => ({ kind: "skip", count: due.length, from: due[0]!.toISOString(), to: handled_through, reason, handled_through });
  if (input.running) return skip("still_running");
  const late = input.now.getTime() - newest.getTime() > SCHEDULED_LATE_MS;
  if (late) {
    const next = inboxScheduledNext(input.schedule, input.now);
    const soon = next !== null && next.getTime() - input.now.getTime() < SCHEDULED_MIN_GAP_MINUTES * MINUTE;
    if (input.if_missed === "skip" || soon) return skip(input.why ?? "missed");
  }
  return { kind: "run", due_at: handled_through, late, missed_before: due.length - 1, handled_through };
}
