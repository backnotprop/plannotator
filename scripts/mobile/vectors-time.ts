/**
 * The time suite's formatting, run by scripts/mobile/vectors.ts in its own
 * process with TZ set to the fixture's time zone: the window's formatters
 * (packages/core/inbox-format.ts) read the zone when they load, so the zone is
 * fixed before they do. Prints the vectors as JSON.
 */
import { clockTime, dateTime, dayWords, fullTime, shortTime, whenTime } from '../../packages/core/inbox-format';
import { readRepoText } from './lib';

const fixture = JSON.parse(readRepoText('apps/mobile/contract/fixtures/time.json')) as { time_zone: string; now: string; moments: string[] };
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
process.stdout.write(JSON.stringify({ time_zone: fixture.time_zone, now: fixture.now, cases }));
