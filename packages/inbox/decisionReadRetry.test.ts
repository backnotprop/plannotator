/**
 * Decision mode reads its thread when the window does not hold it. One slow or failed read used to leave the card on
 * "Reading the question…" forever; now it goes again, and only once every try failed does the card say so (with
 * Try again). decisions/readRetry.ts.
 */
import { expect, test } from 'bun:test';
import { readWithRetries } from './decisions/readRetry';

function clock() {
  const waiting: { run: () => void; ms: number }[] = [];
  return { timers: { set: (run: () => void, ms: number) => waiting.push({ run, ms }), clear: () => {} }, waiting, next: () => waiting.shift()!.run() };
}
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

test('a failed read goes again, later each time, and the first success is drawn', async () => {
  const c = clock();
  let calls = 0;
  const read = async () => {
    calls += 1;
    if (calls < 3) throw new Error('timed out');
    return 'thread';
  };
  const seen: string[] = [];
  readWithRetries(read, { onRead: (v) => seen.push(v), onFailed: () => seen.push('failed') }, { tries: 3, waitMs: 100, timers: c.timers });
  await settle();
  expect(c.waiting.map((w) => w.ms)).toEqual([100]);
  c.next();
  await settle();
  expect(c.waiting.map((w) => w.ms)).toEqual([200]);
  c.next();
  await settle();
  expect(seen).toEqual(['thread']);
});

test('every try failed: the card is told once, never left reading', async () => {
  const c = clock();
  const seen: string[] = [];
  readWithRetries(async () => Promise.reject(new Error('offline')), { onRead: () => seen.push('read'), onFailed: () => seen.push('failed') }, { tries: 2, waitMs: 100, timers: c.timers });
  await settle();
  c.next();
  await settle();
  expect(seen).toEqual(['failed']);
  expect(c.waiting).toHaveLength(0);
});
