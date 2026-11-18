/**
 * The time suite's formatting, run by scripts/mobile/vectors.ts in its own
 * process once per time zone of the fixture, with TZ set to it: the window's
 * formatters (packages/core/inbox-format.ts) read the zone when they load, so
 * the zone is fixed before they do. Prints the cases as JSON.
 */
import { clockTime, dateTime, dayWords, fullTime, shortTime, whenTime } from '../../packages/core/inbox-format';
import { readRepoText } from './lib';

const fixture = JSON.parse(readRepoText('apps/mobile/contract/fixtures/time.json')) as { now: string; moments: string[] };
const now = new Date(fixture.now);
const cases = fixture.moments.map((iso) => ({
  iso,
  shortTime: shortTime(iso, now),
  whenTime: whenTime(iso, now),
  dayWords: dayWords(iso, now),
  dateTime: dateTime(iso, now),
  clockTime: clockTime(iso),
  fullTime: fullTime(iso),
}));
process.stdout.write(JSON.stringify({ time_zone: process.env.TZ, cases }));
