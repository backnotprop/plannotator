import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { shortTime } from './format';
import { RELATIVE_TICK_MS, relativeTime, relativeWords, useRelativeClock } from './relativeTime';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe('the words', () => {
  test('now, then minutes, hours and days, then the date the clock form writes', () => {
    expect(relativeTime(ago(0), NOW)).toBe('now');
    expect(relativeTime(ago(59_999), NOW)).toBe('now');
    expect(relativeTime(ago(MIN), NOW)).toBe('1m');
    expect(relativeTime(ago(59 * MIN), NOW)).toBe('59m');
    expect(relativeTime(ago(60 * MIN), NOW)).toBe('1h');
    expect(relativeTime(ago(23 * 60 * MIN + 59 * MIN), NOW)).toBe('23h');
    expect(relativeTime(ago(24 * 60 * MIN), NOW)).toBe('1d');
    expect(relativeTime(ago(6 * 24 * 60 * MIN), NOW)).toBe('6d');
    const week = ago(7 * 24 * 60 * MIN);
    expect(relativeTime(week, NOW)).toBe(shortTime(week));
  });

  test('a time a little ahead of this clock (another computer\'s) reads "now"', () => {
    expect(relativeTime(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe('now');
    expect(relativeWords(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe('just now');
  });

  test('a screen reader hears the same step in words, singular at one, then the same date', () => {
    expect(relativeWords(ago(59_999), NOW)).toBe('just now');
    expect(relativeWords(ago(MIN), NOW)).toBe('1 minute ago');
    expect(relativeWords(ago(59 * MIN), NOW)).toBe('59 minutes ago');
    expect(relativeWords(ago(60 * MIN), NOW)).toBe('1 hour ago');
    expect(relativeWords(ago(23 * 60 * MIN + 59 * MIN), NOW)).toBe('23 hours ago');
    expect(relativeWords(ago(24 * 60 * MIN), NOW)).toBe('1 day ago');
    expect(relativeWords(ago(6 * 24 * 60 * MIN), NOW)).toBe('6 days ago');
    const week = ago(7 * 24 * 60 * MIN);
    expect(relativeWords(week, NOW)).toBe(shortTime(week));
  });
});

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  if (root) act(() => root!.unmount());
  root = null;
});

describe.if(hasDom)('the shared minute clock', () => {
  test('one timer for every relative row, none for clock rows, gone with the last row', () => {
    const started: number[] = [];
    let running = 0;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      if (ms === RELATIVE_TICK_MS) {
        started.push(ms);
        running += 1;
      }
      return realSetInterval(fn, ms);
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
      running = Math.max(0, running - 1);
      return realClearInterval(id);
    }) as typeof clearInterval;

    const Row = ({ relative }: { relative: boolean }) => createElement('span', null, String(useRelativeClock(relative) > 0));
    const List = ({ relative, count }: { relative: boolean; count: number }) => createElement('div', null, ...Array.from({ length: count }, (_, i) => createElement(Row, { key: i, relative })));
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    act(() => root!.render(createElement(List, { relative: false, count: 40 })));
    expect(started).toEqual([]);
    act(() => root!.render(createElement(List, { relative: true, count: 40 })));
    expect(started).toEqual([RELATIVE_TICK_MS]);
    expect(running).toBe(1);
    act(() => root!.render(createElement(List, { relative: true, count: 3 })));
    expect(started).toEqual([RELATIVE_TICK_MS]);
    act(() => root!.render(createElement(List, { relative: false, count: 3 })));
    expect(running).toBe(0);
  });
});
