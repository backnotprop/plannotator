/**
 * Routines, the pure part: the next-run math (croner, which knows time zones), the 15-minute rule, a
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

/** A one-time `at` as croner reads a wall time in its zone: `YYYY-MM-DDTHH:MM[:SS]`, no offset, a day the calendar has. */
const atText = (at: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2})?$/.exec(at);
  if (!match) throw new Error("a one-time schedule is a date and time, 2026-11-20T17:00");
  const [y, mo, d, h, mi] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59) throw new Error(`${at.slice(0, 10)} at ${at.slice(11, 16)} is not a real date and time`);
  return at.length === 16 ? `${at}:00` : at;
};

const minutesWords = (n: number) => (n === 1 ? "1 minute" : `${n} minutes`);

const UNREAD = "That isn't a schedule Plannotator can read.";

const zoneKnown = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Why a schedule is refused, or null. The words are the editor's and an agent's alike. `now`: a one-time time before
 * it is refused (a new or changed schedule; one already saved keeps its time).
 */
export function inboxScheduleRefusal(schedule: InboxScheduledSchedule, now?: Date): InboxScheduledRefusal | null {
  if (schedule === null) return null;
  if (!zoneKnown(schedule.tz)) return { code: "schedule_invalid", error: `${UNREAD} ${schedule.tz} isn't a time zone it knows; use one such as America/New_York.` };
  let cron: Cron;
  try {
    cron = cronOf(schedule);
    cron.nextRun(new Date(0));
  } catch (error) {
    // A one-time time's reasons are our own words (atText); croner's own text never reaches a person or an agent.
    if ("at" in schedule) return { code: "schedule_invalid", error: `That isn't a schedule: ${error instanceof Error ? error.message : String(error)}.` };
    return { code: "schedule_invalid", error: `${UNREAD} A schedule is a 5-field cron, such as 0 9 * * 1-5.` };
  }
  if (!("cron" in schedule)) return now && cron.nextRun(now) === null ? { code: "schedule_invalid", error: "That time has already passed." } : null;
  const runs = cron.nextRuns(GAP_SAMPLE, new Date(Date.UTC(2026, 0, 1)));
  if (runs.length === 0) return { code: "schedule_invalid", error: "That schedule never runs: no day matches it." };
  let gap = Infinity;
  let widest = 0;
  for (let i = 1; i < runs.length; i++) {
    const apart = runs[i]!.getTime() - runs[i - 1]!.getTime();
    gap = Math.min(gap, apart);
    widest = Math.max(widest, apart);
  }
  if (gap >= SCHEDULED_MIN_GAP_MINUTES * MINUTE) return null;
  const every = Math.max(1, Math.round(gap / MINUTE));
  // `*/14` runs at :56 and then :00: say what is true of it, not "every 4 minutes".
  const how = widest === gap ? `runs every ${every === 1 ? "minute" : minutesWords(every)}` : `can run ${minutesWords(every)} apart`;
  return { code: "schedule_too_frequent", every_minutes: every, error: `Scheduled times are at least ${SCHEDULED_MIN_GAP_MINUTES} minutes apart. This one ${how}.` };
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

/** How far a catch-up counts the due times it folds in or skips: past this, the words say "1,000 or more". */
export const SCHEDULED_COUNT_MAX = 1_000;

/**
 * The due times in (`after`, `through`]: the first, the newest, and how many (counted up to `SCHEDULED_COUNT_MAX`), or
 * null for none. The newest is read back from `through`, so a long sleep costs at most that many steps.
 */
export function inboxScheduledDue(schedule: InboxScheduledSchedule, after: Date, through: Date): { first: Date; newest: Date; count: number } | null {
  const first = inboxScheduledNext(schedule, after);
  if (!schedule || !first || first.getTime() > through.getTime()) return null;
  let newest = first;
  try {
    // Croner reads back strictly before its reference, at whole seconds.
    const back = cronOf(schedule).previousRuns(2, new Date(through.getTime() + 1000)).find((at) => at.getTime() <= through.getTime());
    if (back && back.getTime() > first.getTime()) newest = back;
  } catch {
    // The first is all there is.
  }
  let count = 1;
  for (let next = first; count < SCHEDULED_COUNT_MAX && next.getTime() < newest.getTime(); count++) next = inboxScheduledNext(schedule, next) ?? newest;
  return { first, newest, count };
}

/** "3 times", "1,000 or more times". */
export function inboxScheduledTimes(count: number): string {
  return count >= SCHEDULED_COUNT_MAX ? `${SCHEDULED_COUNT_MAX.toLocaleString("en-US")} or more times` : `${count} times`;
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
    // `*/45` runs at :00 and :45, not every 45 minutes: a step that does not divide the hour says its minutes.
    const step = stepMin ? Number(stepMin[1]) : 0;
    if (step > 0 && hour === "*") return 60 % step === 0 ? `Every ${step} minutes` : `Every hour at ${listed(Array.from({ length: Math.ceil(60 / step) }, (_, i) => `:${String(i * step).padStart(2, "0")}`))}`;
    if (m !== null && hour === "*") return `Every hour at :${String(m).padStart(2, "0")}`;
    const stepHour = /^\*\/(\d+)$/.exec(hour);
    if (m !== null && stepHour && 24 % Number(stepHour[1]) === 0) return `Every ${stepHour[1]} hours, at minute ${m}`;
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
  const refused = inboxScheduleRefusal(schedule, now);
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
 * One check for one routine that is on (spec appendix B): the due times since `handled_through`; none:
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
  if (!due) return { kind: "wait" };
  const { newest } = due;
  const handled_through = newest.toISOString();
  const skip = (reason: InboxScheduledSkipReason): InboxScheduledDecision => ({ kind: "skip", count: due.count, from: due.first.toISOString(), to: handled_through, reason, handled_through });
  if (input.running) return skip("still_running");
  const late = input.now.getTime() - newest.getTime() > SCHEDULED_LATE_MS;
  if (late) {
    const next = inboxScheduledNext(input.schedule, input.now);
    const soon = next !== null && next.getTime() - input.now.getTime() < SCHEDULED_MIN_GAP_MINUTES * MINUTE;
    if (soon) return skip(input.why ?? "missed");
    if (input.if_missed === "skip") return skip(input.why ?? "late");
  }
  return { kind: "run", due_at: handled_through, late, missed_before: due.count - 1, handled_through };
}

/**
 * The characters a plain name may hold: letters (with their marks), numbers, emoji, a space, and punctuation no inline
 * renderer of a thread reads as markup where these lines put a name (always mid-line, after a space: inside a link's
 * words, or before `.`, ` (` or `).`). The window's InlineMarkdown, core `cleanInline` and the phone's inline Markdown
 * draw them as typed (`'` the window draws as `’`, its smart quotes: only how it looks; the line keeps `'`). Left
 * out, so such a name is code: `"`, `_ * ~` (emphasis), `[ ] ! < > & \ $ # @ : / | =` and backticks (links,
 * pictures, tags, references, escapes, math, refs, mentions, emoji codes, URLs, paths), and any other space, control or
 * direction mark.
 */
const PLAIN_NAME = /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0F .,'’\-–—()+?]*$/u;

/** A path may also hold `/`, `_` and a leading `~/`, and no `.`: see `isPlainLineText`. */
const PLAIN_PATH = /^(?:~\/)?[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0F ,'’\-–—()+?/_]*$/u;

/**
 * Whether text reads as typed, and draws as nothing but its words, written into a change line as it is. Besides the
 * characters above: no space at either end; no `www.` (an address GFM links bare); no `..` or `--` (the window's
 * smart punctuation draws `…`, `–` and `—`, and a name's last `.` meets the line's own); no word shaped like a Linear
 * issue (`ENG-42`: the window links it when Linear is on). A path: no `.` (a bare path or code file the window opens
 * ends in `.ext`), its `~` only as `~/` at its start (after a space, so it never closes a strikethrough), and each `_`
 * after an ASCII letter, digit or `_` (so it never opens emphasis: InlineMarkdown's and `cleanInline`'s rule).
 */
function isPlainLineText(text: string, kind: "name" | "path"): boolean {
  if (!(kind === "path" ? PLAIN_PATH : PLAIN_NAME).test(text)) return false;
  if (text.startsWith(" ") || text.endsWith(" ")) return false;
  if (/www\./i.test(text) || text.includes("..") || text.includes("--")) return false;
  // The Linear linker's shape (`linearCards.tsx` MAYBE_IDENTIFIER), without its end check: wider, never narrower.
  if (/(?<![\w/.-])[A-Za-z][A-Za-z0-9]{0,9}-[1-9]/.test(text)) return false;
  if (kind === "path" && /(?<![A-Za-z0-9_])_/.test(text)) return false;
  // Nothing invisible: a filler letter or a selector with no emoji to sit on would leave the line reading as empty.
  if (/\p{Default_Ignorable_Code_Point}/u.test(text.replace(/[\u200D\uFE0F]/gu, ""))) return false;
  // A mark needs a letter to sit on: no name made only of marks, none starting a word.
  if (!/[^\p{M}\u200D\uFE0F]/u.test(text) || /(^| )\p{M}/u.test(text)) return false;
  return true;
}

/**
 * A routine's name (or a folder's path) as text in a change line. A plain one (`isPlainLineText`) is written as it
 * is, as it always was. Any other is inline code, so it is never a picture, a link, a tag, a mention or an issue ref,
 * whoever named it (a name is free text, an agent's anywhere), and still reads exactly as typed everywhere: the window
 * draws a code span's text as it is, a plain-text line (a list row's preview, a folded line: core `cleanInline`) drops
 * only the backticks, and an agent reading the thread reads it as literal text. The fence is one backtick longer than
 * any run in the text, padded with a space when the text starts or ends with one, as CommonMark reads it; a line break
 * reads as a space, so the span stays on its line.
 */
export function routineLineText(text: string, kind: "name" | "path" = "name"): string {
  if (isPlainLineText(text, kind)) return text;
  const one = text.replace(/[\r\n]+/g, " ");
  const ticks = "`".repeat(Math.max(0, ...[...one.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = one.startsWith("`") || one.endsWith("`") || (one.startsWith(" ") && one.endsWith(" ")) ? " " : "";
  return `${ticks}${pad}${one}${pad}${ticks}`;
}
