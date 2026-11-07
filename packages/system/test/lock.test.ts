import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** Timings for tests: a stale heartbeat is one older than a second, looked at again 50 ms later. */
const FAST = { heartbeatMs: 20, settleMs: 5, staleSettleMs: 50, staleMs: 1000 };

test('an empty lock (a taker between making the file and writing it) is held, not broken', async () => {
  const path = lockPath();
  writeFileSync(path, '');
  expect(await takeLock(path, FAST)).toBeNull();
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
    const got = (await Promise.all(Array.from({ length: 8 }, () => takeLock(path, FAST)))).filter((r) => r !== null);
    expect(got).toHaveLength(1);
    await got[0]!();
  }
});

test('two takers that both read the same dead lock: the break guard lets only one remove it, whatever the order', async () => {
  const path = lockPath();
  writeFileSync(path, String(DEAD));
  // both takers reach the removal before either removes; the second removes after the first has made its own lock
  let arrived = 0;
  let order = 0;
  const bothThere = async () => {
    arrived++;
    for (let i = 0; i < 20 && arrived < 2; i++) await sleep(10);
  };
  const beforeBreak = async () => {
    const me = order++;
    await bothThere();
    if (me === 1) await sleep(50);
  };
  const got = (await Promise.all([takeLock(path, { ...FAST, beforeBreak }), takeLock(path, { ...FAST, beforeBreak })])).filter((r) => r !== null);
  expect(got).toHaveLength(1);
  await got[0]!();
});

test('a breaker whose guard was taken over while it paused removes nothing and leaves the other guard in place', async () => {
  const path = lockPath();
  const guard = `${path}.break`;
  writeFileSync(path, String(DEAD));
  // another taker found this one's guard stale and took the guard over
  const beforeBreak = async () => writeFileSync(guard, 'another-breaker');
  expect(await takeLock(path, { ...FAST, beforeBreak })).toBeNull();
  expect(readFileSync(guard, 'utf8')).toBe('another-breaker');
  expect(readFileSync(path, 'utf8')).toBe(String(DEAD));
});

test('a lock whose pid is alive but whose heartbeat is stale (a pid reused by another process) is broken; a fresh one is held', async () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ token: 'an-old-holder', pid: process.pid }));
  expect(await takeLock(path, FAST)).toBeNull();
  utimesSync(path, ago(120_000), ago(120_000));
  const release = await takeLock(path, FAST);
  expect(release).not.toBeNull();
  expect(JSON.parse(readFileSync(path, 'utf8')).token).not.toBe('an-old-holder');
  await release!();
});

test('a live holder whose heartbeat lands more than one beat late (a busy wake, a clock jump) keeps its lock', async () => {
  const path = lockPath();
  const holder = await takeLock(path, { heartbeatMs: 150 });
  expect(holder).not.toBeNull();
  utimesSync(path, ago(10_000), ago(10_000)); // as after a Mac's sleep: the next beat is 150 ms away
  // the taker expects a beat every 50 ms; the second look waits two and a half beats and more, not one
  expect(await takeLock(path, { heartbeatMs: 50, settleMs: 10, staleSettleMs: 400, staleMs: 1000 })).toBeNull();
  expect(holder!.lost).toBe(false);
  await holder!();
});

test('a holder whose lock another taker broke is told: lost, its signal aborted, and its release leaves the new lock', async () => {
  const path = lockPath();
  const holder = await takeLock(path, { heartbeatMs: 20 });
  expect(holder).not.toBeNull();
  expect(holder!.lost).toBe(false);
  const other = JSON.stringify({ token: 'another-holder', pid: process.pid });
  writeFileSync(path, other);
  for (let i = 0; i < 50 && !holder!.lost; i++) await sleep(10);
  expect(holder!.lost).toBe(true);
  expect(holder!.signal.aborted).toBe(true);
  expect(await holder!.check()).toBe(false);
  await holder!();
  expect(readFileSync(path, 'utf8')).toBe(other);
});

test('on a file system with no hard links (FAT, exFAT, SMB) the lock is made by an exclusive create, and still held once', async () => {
  const path = lockPath();
  const link = async () => {
    throw Object.assign(new Error('ENOTSUP: operation not supported on socket, link'), { code: 'ENOTSUP' });
  };
  const first = await takeLock(path, { ...FAST, link });
  expect(first).not.toBeNull();
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid });
  expect(await takeLock(path, { ...FAST, link })).toBeNull();
  await first!();
  expect(existsSync(path)).toBe(false);
});

test("a taker removes the temp lock files of takers that died mid-take, and keeps a live taker's", async () => {
  const path = lockPath();
  const dead = join(dirname(path), `tick.lock.tmp-${DEAD}-0a1b2c`);
  const deadGuard = join(dirname(path), `tick.lock.break.tmp-${DEAD}-0a1b2c`);
  const live = join(dirname(path), `tick.lock.tmp-${process.pid}-0a1b2c`);
  for (const f of [dead, deadGuard, live]) writeFileSync(f, '{}');
  const release = await takeLock(path, FAST);
  expect(release).not.toBeNull();
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(deadGuard)).toBe(false);
  expect(existsSync(live)).toBe(true);
  await release!();
});

test('on a file system whose link() fails with another code (Windows FAT: EISDIR), the lock still falls back to an exclusive create', async () => {
  const path = lockPath();
  const link = async () => {
    throw Object.assign(new Error('EISDIR: illegal operation on a directory, link'), { code: 'EISDIR' });
  };
  const first = await takeLock(path, { ...FAST, link });
  expect(first).not.toBeNull();
  expect(await takeLock(path, { ...FAST, link })).toBeNull();
  await first!();
  expect(existsSync(path)).toBe(false);
});

test('a lock file that cannot be read for a moment (not gone, not another token) is still held, and the next look sees it', async () => {
  const path = lockPath();
  const holder = await takeLock(path, { heartbeatMs: 60_000 });
  expect(holder).not.toBeNull();
  chmodSync(path, 0o000); // the read fails with EACCES, as EMFILE or a sharing violation would
  try {
    expect(await holder!.check()).toBe(true);
    expect(holder!.lost).toBe(false);
    expect(holder!.signal.aborted).toBe(false);
  } finally {
    chmodSync(path, 0o600);
  }
  expect(await holder!.check()).toBe(true);
  await holder!();
  expect(existsSync(path)).toBe(false);
});
