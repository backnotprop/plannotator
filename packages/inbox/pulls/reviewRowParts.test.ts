/**
 * A compact Reviews row's parts (reviewRowParts.ts). What regresses: an age that outgrows its fixed column (a date
 * instead of "11mo"), and a long unbroken title split where it loses its end, inside a character, or when it is
 * words or right-to-left.
 */
import { expect, test } from 'bun:test';
import { reviewAge, titleTail } from './reviewRowParts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const before = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

test('an age is at most four characters, however old', () => {
  const DAY = 24 * 60;
  const cases: [number, string][] = [
    [0, 'now'],
    [59, '59m'],
    [60, '1h'],
    [23 * 60 + 59, '23h'],
    [6 * DAY, '6d'],
    [7 * DAY, '1w'],
    [29 * DAY, '4w'],
    [30 * DAY, '1mo'],
    [364 * DAY, '11mo'],
    [365 * DAY, '1y'],
    [40 * 365 * DAY, '40y'],
  ];
  expect(cases.map(([minutes]) => reviewAge(before(minutes), NOW))).toEqual(cases.map(([, age]) => age));
  for (const [minutes] of cases) expect(reviewAge(before(minutes), NOW).length).toBeLessThanOrEqual(4);
  // A clock behind the forge's: never a negative age.
  expect(reviewAge(before(-5), NOW)).toBe('now');
});

test('a long unbroken title keeps its end from a separator; words, short runs and right-to-left text stay whole', () => {
  expect(titleTail('Review billing: fix/retry-jitter-on-charge-timeouts')).toEqual({ head: 'Review billing: fix/retry-jitter-on-charge-', tail: 'timeouts' });
  const hash = 'a'.repeat(30) + '0123456789';
  expect(titleTail(hash)).toEqual({ head: 'a'.repeat(30), tail: '0123456789' });
  expect(titleTail('Inbox: combine threads that answer the same question')).toBeNull();
  expect(titleTail('fix/short-name')).toBeNull();
  expect(titleTail('إصلاح/عرض-قائمة-المراجعات-الطويلة-جدا')).toBeNull();
  // Never inside an emoji: the tail is whole characters.
  const split = titleTail(`${'x'.repeat(20)}👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻`);
  expect(split!.tail).toBe('👩‍💻'.repeat(10));
});
