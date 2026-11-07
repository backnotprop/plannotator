/**
 * What the open thread keeps of a return (approval `snooze-back-line`), and
 * which message the line sits above. The drawn line: snoozeBackLine.test.tsx.
 * The whole flow: tests/e2e/inbox-snooze-back.spec.ts.
 */
import { describe, expect, test } from 'bun:test';
import { snoozeBackAbove, snoozeBackAfter } from './snoozeBack';

const UNTIL = '2026-11-05T13:00:00.000Z';
const back = { snoozed: null, snooze_back: UNTIL };
const settled = { snoozed: null, snooze_back: null };
const running = { snoozed: { until: '2999-01-01T00:00:00.000Z', at: UNTIL }, snooze_back: null };

describe('snoozeBackAfter', () => {
  test('nothing kept for a row that never came back', () => {
    expect(snoozeBackAfter(null, 'msg_a', settled)).toBeNull();
    expect(snoozeBackAfter(null, 'msg_a', running)).toBeNull();
  });

  test("the row's return is kept after the look takes it off the row", () => {
    const kept = snoozeBackAfter(null, 'msg_a', back);
    expect(kept).toEqual({ threadId: 'msg_a', until: UNTIL });
    expect(snoozeBackAfter(kept, 'msg_a', settled)).toBe(kept);
    // A read that has no row yet takes nothing away.
    expect(snoozeBackAfter(kept, 'msg_a', null)).toBe(kept);
  });

  test('gone on leaving the thread, and not carried to the next one', () => {
    const kept = snoozeBackAfter(null, 'msg_a', back);
    expect(snoozeBackAfter(kept, null, null)).toBeNull();
    expect(snoozeBackAfter(kept, 'msg_b', settled)).toBeNull();
  });

  test('snoozing again takes it away, so an Unsnooze after does not bring it back', () => {
    const kept = snoozeBackAfter(null, 'msg_a', back);
    const again = snoozeBackAfter(kept, 'msg_a', running);
    expect(again).toBeNull();
    expect(snoozeBackAfter(again, 'msg_a', settled)).toBeNull();
  });

  test('a second return is the later time', () => {
    const later = '2026-11-05T15:00:00.000Z';
    expect(snoozeBackAfter({ threadId: 'msg_a', until: UNTIL }, 'msg_a', { snoozed: null, snooze_back: later })).toEqual({ threadId: 'msg_a', until: later });
  });
});

describe('snoozeBackAbove', () => {
  const messages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  test('above the first new message', () => {
    expect(snoozeBackAbove(messages, new Set(['b', 'c']))).toBe('b');
    expect(snoozeBackAbove(messages, new Set(['a', 'b', 'c']))).toBe('a');
  });

  test('with nothing new, above the last message', () => {
    expect(snoozeBackAbove(messages, new Set())).toBe('c');
    expect(snoozeBackAbove([{ id: 'only' }], new Set())).toBe('only');
  });
});
