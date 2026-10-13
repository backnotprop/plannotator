/**
 * Times and counts as the window says them (the stress test of 2026-10-12,
 * rows 10 to 12 and 24): a time in a thread says its day when it is not
 * today, a date in the list says its year when it is not this year, and a
 * count over 999 has its thousands separated. Today's times and small counts
 * read exactly as before.
 */
import { describe, expect, test } from 'bun:test';
import { dateTime, dayWords, formatCount, plural, questionCount, shortTime, whenTime } from './format';

// Local times, so the day boundaries are the person's own.
const now = new Date(2026, 9, 12, 21, 30);
const at = (y: number, m: number, d: number, h = 20, min = 22) => new Date(y, m, d, h, min).toISOString();

describe('whenTime', () => {
  test('today is the clock alone, as before', () => {
    expect(whenTime(at(2026, 9, 12), now)).toBe('8:22 PM');
  });
  test("yesterday's message never reads like today's", () => {
    expect(whenTime(at(2026, 9, 11), now)).toBe('Oct 11, 8:22 PM');
    expect(whenTime(at(2026, 9, 11), now)).not.toBe(whenTime(at(2026, 9, 12), now));
  });
  test('another year names it', () => {
    expect(whenTime(at(2025, 8, 2), now)).toBe('Sep 2, 2025, 8:22 PM');
  });
  test('an unreadable time is nothing', () => {
    expect(whenTime('not a date', now)).toBe('');
  });
});

describe('shortTime (the list)', () => {
  test('today the clock, this year the day, another year the day and the year', () => {
    expect(shortTime(at(2026, 9, 12, 9, 5), now)).toBe('9:05 AM');
    expect(shortTime(at(2026, 8, 10), now)).toBe('Sep 10');
    expect(shortTime(at(2025, 8, 2), now)).toBe('Sep 2, 2025');
  });
  test('across New Year: December 31 is last year on January 1', () => {
    expect(shortTime(new Date(2025, 11, 31, 23, 0).toISOString(), new Date(2026, 0, 1, 0, 30))).toBe('Dec 31, 2025');
  });
  test('dayWords and dateTime name another year too', () => {
    expect(dayWords(at(2025, 8, 2), now)).toBe('Sep 2, 2025');
    expect(dayWords(at(2026, 9, 11), now)).toBe('yesterday');
    expect(dateTime(at(2026, 9, 3), now)).toBe('Oct 3, 8:22 PM');
    expect(dateTime(at(2025, 9, 3), now)).toBe('Oct 3, 2025, 8:22 PM');
  });
});

describe('counts', () => {
  test('thousands are separated; small counts read as before', () => {
    expect(formatCount(1284)).toBe('1,284');
    expect(formatCount(7)).toBe('7');
    expect(plural(1284, 'thread')).toBe('1,284 threads');
    expect(plural(1, 'thread')).toBe('1 thread');
    expect(plural(0, 'thread')).toBe('0 threads');
    expect(questionCount(1500)).toBe('1,500 questions');
    expect(questionCount(1)).toBe('');
  });
});
