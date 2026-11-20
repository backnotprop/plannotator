/**
 * The snooze suite's rules, run by scripts/mobile/vectors.ts in its own
 * process once per time zone of the fixture, with TZ set to it: the window's
 * snooze rules (packages/core/inbox-snooze.ts) build every day and time from
 * local parts, so the zone is fixed before they run. Prints the cases as JSON.
 */
import type { InboxListRow, InboxListSection } from '../../packages/core/inbox-types';
import {
  inboxSectionsAsOf,
  inboxSnoozeChoices,
  inboxSnoozeDays,
  inboxSnoozeDelay,
  inboxSnoozeFirstPick,
  inboxSnoozeKeepTime,
  inboxSnoozeRefusal,
  inboxSnoozeRunning,
  inboxSnoozeTimes,
  inboxSnoozeWhen,
  inboxSplitSnoozed,
} from '../../packages/core/inbox-snooze';
import { readRepoText } from './lib';

type Fixture = {
  nows: string[];
  pick_days: string[];
  pick_days_count: number;
  when: string[];
  keep_time: string[];
  refusals: unknown[];
  rows_now: string;
  rows: (Partial<InboxListRow> & { thread_id: string; note: string })[];
  sections: { id: string; label: string; threads: string[] }[];
  section_rows: (Partial<InboxListRow> & { thread_id: string; note: string })[];
};

const fixture = JSON.parse(readRepoText('apps/mobile/contract/fixtures/snooze.json')) as Fixture;
const ids = (rows: readonly InboxListRow[]) => rows.map((r) => r.thread_id);

const nows = fixture.nows.map((iso) => {
  const now = new Date(iso);
  const days = inboxSnoozeDays(now, fixture.pick_days_count);
  return {
    now: iso,
    choices: inboxSnoozeChoices(now),
    days,
    first_pick: inboxSnoozeFirstPick(now),
    // Pick a time's half hours on each listed day and on each fixed day (a clock change's day among them).
    times: [...new Set([...days.map((d) => d.key), ...fixture.pick_days])].map((day) => ({ day, times: inboxSnoozeTimes(day, now) })),
    when: fixture.when.map((iso) => ({ iso, words: inboxSnoozeWhen(iso, now) })),
  };
});

const rowsNow = new Date(fixture.rows_now);
const rows = fixture.rows as unknown as InboxListRow[];
const split = inboxSplitSnoozed(rows, rowsNow);
const byId = new Map([...fixture.section_rows, ...fixture.rows].map((r) => [r.thread_id, r as unknown as InboxListRow]));
const sections = fixture.sections.map((s) => ({ id: s.id, label: s.label, threads: s.threads.map((t) => byId.get(t)!) })) as unknown as InboxListSection[];
const asOf = inboxSectionsAsOf(sections, rows, rowsNow);
const keepTimes = inboxSnoozeTimes(fixture.pick_days[0]!, new Date(fixture.nows[0]!));

process.stdout.write(
  JSON.stringify({
    time_zone: process.env.TZ,
    nows,
    rows: {
      now: fixture.rows_now,
      // Each row as it stands by `now`, and whether it is still snoozed.
      as_of: split.rows.concat(split.snoozed).map((r) => ({ thread_id: r.thread_id, section: r.section, unread: r.unread, last_at: r.last_at, snoozed: r.snoozed ?? null, snooze_back: r.snooze_back ?? null })),
      listed: ids(split.rows),
      snoozed: ids(split.snoozed),
      sections: asOf.sections.map((s) => ({ id: s.id, threads: ids(s.threads) })),
      band: ids(asOf.snoozed),
      running: fixture.rows.map((r) => ({ thread_id: r.thread_id, running: r.snoozed ? inboxSnoozeRunning(r.snoozed.until, rowsNow) : false })),
      delay_ms: inboxSnoozeDelay(fixture.rows.flatMap((r) => (r.snoozed ? [r.snoozed.until] : [])), rowsNow),
    },
    keep_time: { day: fixture.pick_days[0], now: fixture.nows[0], cases: fixture.keep_time.map((time) => ({ time, kept: inboxSnoozeKeepTime(keepTimes, time) })) },
    refusals: fixture.refusals.map((until) => ({ until, refusal: inboxSnoozeRefusal(until, new Date(fixture.nows[0]!)) })),
  }),
);
