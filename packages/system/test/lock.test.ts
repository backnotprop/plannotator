import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeLock } from '../src/node/index.ts';
import { tempDir } from './helpers.ts';

// tick.lock: taken by every tick and, for its whole run, by the Inbox's first draw.

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
const lockPath = () => {
  const t = tempDir();
  cleanups.push(t.done);
  return join(t.dir, 'tick.lock');
};
const DEAD = 99999999;
const ago = (ms: number) => new Date(Date.now() - ms);

test('an empty lock (a taker between making the file and writing it, in an older Plannotator) is held, not broken', async () => {
  const path = lockPath();
  writeFileSync(path, '');
  expect(await takeLock(path, { settleMs: 5 })).toBeNull();
  expect(existsSync(path)).toBe(true);
});

test('a release lets go of its own lock only: a lock taken over and taken again stays', async () => {
  const path = lockPath();
  const first = await takeLock(path);
  expect(first).not.toBeNull();
  unlinkSync(path); // broken by another taker, as a stale lock is
  const second = await takeLock(path);
  expect(second).not.toBeNull();
  await first!();
  expect(existsSync(path)).toBe(true);
  await second!();
  expect(existsSync(path)).toBe(false);
});

test('takers of a dead lock at once: exactly one gets it', async () => {
  const path = lockPath();
  for (let round = 0; round < 50; round++) {
    writeFileSync(path, String(DEAD));
    const got = (await Promise.all(Array.from({ length: 8 }, () => takeLock(path, { settleMs: 5 })))).filter((r) => r !== null);
    expect(got).toHaveLength(1);
    await got[0]!();
  }
});

test('a lock whose pid is alive but whose heartbeat is stale (a pid reused by another process) is broken; a fresh one is held', async () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ token: 'an-old-holder', pid: process.pid }));
  expect(await takeLock(path, { heartbeatMs: 20, settleMs: 20, staleMs: 60_000 })).toBeNull();
  utimesSync(path, ago(120_000), ago(120_000));
  const release = await takeLock(path, { heartbeatMs: 20, settleMs: 20, staleMs: 60_000 });
  expect(release).not.toBeNull();
  expect(JSON.parse(readFileSync(path, 'utf8')).token).not.toBe('an-old-holder');
  await release!();
});

test('a live holder whose heartbeat was late touches the lock before the second look: it is not broken', async () => {
  const path = lockPath();
  const holder = await takeLock(path, { heartbeatMs: 50 });
  expect(holder).not.toBeNull();
  utimesSync(path, ago(10_000), ago(10_000)); // as after a Mac's sleep
  expect(await takeLock(path, { heartbeatMs: 50, settleMs: 100, staleMs: 1000 })).toBeNull();
  expect(existsSync(path)).toBe(true);
  await holder!();
});
