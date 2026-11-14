import { expect, test } from 'bun:test';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { joinThreadRead, type ThreadFlight } from './threadFlights';

test('reads of one thread never overlap: a second ask joins the one out and one more read follows it', async () => {
  const flights = new Map<string, ThreadFlight>();
  let out = 0;
  let most = 0;
  let reads = 0;
  const releases: (() => void)[] = [];
  const read = (threadId: string) => {
    reads += 1;
    out += 1;
    most = Math.max(most, out);
    return new Promise<InboxThread | null>((done) => releases.push(() => {
      out -= 1;
      done({ thread_id: threadId } as InboxThread);
    }));
  };
  const first = joinThreadRead(flights, 't', undefined, read);
  const second = joinThreadRead(flights, 't', undefined, read);
  const third = joinThreadRead(flights, 't', undefined, read);
  expect(second).toBe(first);
  expect(third).toBe(first);
  expect(reads).toBe(1);
  releases.shift()!();
  await first;
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(reads).toBe(2);
  releases.shift()!();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(most).toBe(1);
  expect(flights.size).toBe(0);
});

test('a read that leaves the open thread stale is followed by another, a few times at most', async () => {
  const flights = new Map<string, ThreadFlight>();
  let reads = 0;
  let stale = true;
  const read = async (threadId: string) => {
    reads += 1;
    if (reads === 2) stale = false;
    return { thread_id: threadId } as InboxThread;
  };
  await joinThreadRead(flights, 't', undefined, read, () => stale);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(reads).toBe(2);
  stale = true;
  reads = 10;
  await joinThreadRead(flights, 'u', undefined, read, () => true);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(reads).toBeLessThanOrEqual(14);
});
