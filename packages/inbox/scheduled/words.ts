/** The words routines show: times, the list's order, and the lines in a thread. Pure. */
import type { InboxScheduledOutcome, InboxScheduledRow, InboxScheduledRun, InboxScheduledSchedule, InboxScheduledSkipReason } from '@plannotator/core/inbox-scheduled-types';
import { plural } from '../format';

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DAY_MS = 86_400_000;

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysBetween = (a: Date, b: Date) => Math.round((dayStart(b) - dayStart(a)) / DAY_MS);
const time = (d: Date) => TIME.format(d);

/** "9:00 AM" on `ref`'s day, "yesterday 9:00 AM", "Wed 2:00 AM" within the week, else "Nov 2, 9:00 AM". */
export function timeFrom(iso: string, ref: Date = new Date()): string {
  const d = new Date(iso);
  const days = daysBetween(d, ref);
  if (days === 0) return time(d);
  if (days === 1) return `yesterday ${time(d)}`;
  if (days > 1 && days < 7) return `${WEEKDAY.format(d)} ${time(d)}`;
  return `${MONTH_DAY.format(d)}, ${time(d)}`;
}

/** The list's Last run: "Today 11:50 AM", "Yesterday 5:02 PM", else "Fri, Nov 6". */
export function lastRunWords(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = daysBetween(d, now);
  if (days === 0) return `Today ${time(d)}`;
  if (days === 1) return `Yesterday ${time(d)}`;
  return `${WEEKDAY.format(d)}, ${MONTH_DAY.format(d)}`;
}

/** A run in the editor's Runs: "Today 9:00 AM", "Thu 11:16 AM", else "Nov 2, 9:01 AM". */
export function runWhenWords(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = daysBetween(d, now);
  if (days === 0) return `Today ${time(d)}`;
  if (days > 0 && days < 7) return `${WEEKDAY.format(d)} ${time(d)}`;
  return `${MONTH_DAY.format(d)}, ${time(d)}`;
}

/** "In 14 hours", "In 3 days"; "Off", "Done", or "None" with no schedule. */
export function nextRunWords(row: Pick<InboxScheduledRow, 'state' | 'schedule' | 'next_run'>, now = Date.now()): string {
  if (row.state === 'off') return 'Off';
  if (row.state === 'done') return 'Done';
  if (!row.schedule || !row.next_run) return 'None';
  const minutes = Math.max(1, Math.round((Date.parse(row.next_run) - now) / 60_000));
  if (minutes < 60) return `In ${plural(minutes, 'minute')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `In ${plural(hours, 'hour')}`;
  return `In ${plural(Math.round(hours / 24), 'day')}`;
}

/** Created: "now", "4m", "3h", "11d". */
export function createdWords(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/** "0:42", "12:05", "1:02:09". */
export function elapsedWords(sinceIso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const at = (hour: number, minute: number) => TIME.format(new Date(2026, 0, 1, hour, minute));

/** The short line under a name in the narrow list: "Weekdays 9:00 AM", "Hourly at :15", "No schedule". */
export function shortScheduleWords(row: Pick<InboxScheduledRow, 'schedule' | 'schedule_words' | 'state' | 'next_run' | 'last_run'>): string {
  const s = row.schedule;
  if (!s) return 'No schedule';
  if ('at' in s) {
    const [date = '', clock = '00:00'] = s.at.split('T');
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = clock.split(':').map(Number);
    const when = new Date(y!, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
    return `Once, ${WEEKDAY.format(when)} ${time(when)}${row.state === 'done' ? ' · Done' : ''}`;
  }
  const m = /^(\d{1,2}) (\*|\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(s.cron.trim());
  if (!m) return row.schedule_words;
  const minute = Number(m[1]);
  if (m[2] === '*') return m[3] === '*' ? `Hourly at :${String(minute).padStart(2, '0')}` : row.schedule_words;
  const clock = at(Number(m[2]), minute);
  if (m[3] === '*') return `Daily ${clock}`;
  if (m[3] === '1-5') return `Weekdays ${clock}`;
  return `${DAYS[Number(m[3])]} ${clock}`;
}

/** On and running first, then done, newest last run first; the turned-off ones apart. */
export function splitScheduled(rows: readonly InboxScheduledRow[]): { on: InboxScheduledRow[]; off: InboxScheduledRow[] } {
  const last = (row: InboxScheduledRow) => (row.state === 'running' && row.running_since ? row.running_since : (row.last_run?.started_at ?? ''));
  const sorted = [...rows].sort((a, b) => last(b).localeCompare(last(a)) || b.created_at.localeCompare(a.created_at));
  return { on: sorted.filter((row) => row.state !== 'off'), off: sorted.filter((row) => row.state === 'off') };
}

export const OUTCOME_WORDS: Record<InboxScheduledOutcome, string> = { running: 'Running', replied: 'Replied', didnt_finish: "Didn't finish", didnt_start: "Didn't start" };

const REASON_WORDS: Record<Exclude<InboxScheduledSkipReason, 'still_running'>, string> = {
  asleep: 'this computer was asleep',
  not_running: "the Inbox wasn't running",
  missed: 'the next run was less than 15 minutes away',
  late: "it couldn't start on time",
};

/** A run divider: "Run 8 · due 9:00 AM, ran 11:14 AM · 1 earlier time missed"; `alone` (nothing came after it) adds the time. */
export function dividerWords(run: InboxScheduledRun, createdAt: string, alone: boolean): string {
  const parts = [`Run ${run.run}`];
  if (run.late) parts.push(`due ${timeFrom(run.due_at, new Date(createdAt))}, ran ${time(new Date(createdAt))}`);
  else if (alone) parts.push(time(new Date(createdAt)));
  if (run.missed_before) parts.push(`${plural(run.missed_before, 'earlier time')} missed`);
  return parts.join(' · ');
}

/** A skip line: "Skipped Wed 2:00 AM · this computer was asleep", "Skipped 5 times, 9:00 AM to 1:00 PM · …". */
export function skipWords(run: InboxScheduledRun, now: Date = new Date()): string {
  const skipped = run.skipped;
  if (!skipped) return 'Skipped';
  // A newer Inbox's reason this window does not know: the time alone.
  const reason = skipped.reason === 'still_running' ? 'the last run was still going' : REASON_WORDS[skipped.reason];
  const when = skipped.count > 1 ? `${skipped.count} times, ${timeFrom(skipped.from, now)} to ${timeFrom(skipped.to, now)}` : timeFrom(skipped.to, now);
  return reason ? `Skipped ${when} · ${reason}` : `Skipped ${when}`;
}

/** The thread's fold over earlier runs: "6 earlier runs, Nov 2 to Nov 9". */
export function earlierRunsWords(dueTimes: readonly string[]): string {
  const sorted = [...dueTimes].sort();
  const from = MONTH_DAY.format(new Date(sorted[0]!));
  const to = MONTH_DAY.format(new Date(sorted[sorted.length - 1]!));
  return `${plural(sorted.length, 'earlier run')}, ${from === to ? from : `${from} to ${to}`}`;
}

/** The foot: "next Mon 9:00 AM" ("next 9:00 AM" today). */
export function nextWhenWords(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = daysBetween(now, d);
  if (days === 0) return time(d);
  if (days > 0 && days < 7) return `${WEEKDAY.format(d)} ${time(d)}`;
  return `${MONTH_DAY.format(d)}, ${time(d)}`;
}

/** The editor's foot: "On · next run today at 7:00 PM" ("tomorrow at", "Wed at", else "Nov 30 at"). */
export function footNextWords(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = daysBetween(now, d);
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 1 && days < 7 ? WEEKDAY.format(d) : MONTH_DAY.format(d);
  return `${day} at ${time(d)}`;
}

/** The editor's "Next run Mon, Nov 16 at 9:00 AM EST", in the schedule's own zone. */
export function nextRunLine(iso: string, schedule: InboxScheduledSchedule, tzShort: string | null): string {
  const zone = schedule?.tz;
  const opts = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, zone ? { ...o, timeZone: zone } : o);
  const d = new Date(iso);
  const day = opts({ weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  return `Next run ${day} at ${opts({ hour: 'numeric', minute: '2-digit' }).format(d)}${tzShort ? ` ${tzShort}` : ''}`;
}
