/**
 * When a star pops: only this window's own starring, of that thread, a moment ago. The motion in a browser (once, not
 * after a reload, not for a star from elsewhere, not under reduced motion) is tests/e2e/inbox-row-star.spec.ts.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { noteStarred, starPopping } from './starPop';

afterEach(() => setSystemTime());

test('the thread just starred pops, and no other; nothing pops once the moment has passed', () => {
  setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
  noteStarred('a');
  expect(starPopping('a')).toBe(true);
  expect(starPopping('b')).toBe(false);
  // The sidebar's star asks with no thread: any star just starred.
  expect(starPopping()).toBe(true);
  setSystemTime(new Date('2026-11-05T10:00:01.500Z'));
  expect(starPopping('a')).toBe(true);
  setSystemTime(new Date('2026-11-05T10:00:01.501Z'));
  expect(starPopping('a')).toBe(false);
  expect(starPopping()).toBe(false);
});

test('a star that failed takes its moment back', () => {
  setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
  noteStarred('a');
  noteStarred(null);
  expect(starPopping('a')).toBe(false);
  expect(starPopping()).toBe(false);
});

test('before anything is starred, nothing pops', async () => {
  // A fresh copy of the module: a window just loaded (a reload) remembers nothing.
  const fresh = await import(`./starPop?fresh=${Date.now()}`);
  expect(fresh.starPopping('a')).toBe(false);
  expect(fresh.starPopping()).toBe(false);
});
