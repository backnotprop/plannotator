import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { noteStarred, starPopping } from './starPop';

afterEach(() => setSystemTime());

test('the thread just starred pops, and no other; nothing pops once the moment has passed', () => {
  setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
  noteStarred('a');
  expect(starPopping('a')).toBe(true);
  expect(starPopping('b')).toBe(false);
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
