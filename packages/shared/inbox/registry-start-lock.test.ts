/**
 * The Inbox's start lock (`acquireInboxStartLock`): one starter at a time, and a start that crashed (a force quit,
 * a kill during a long move into SQLite) does not hold the next one back. The failure this guards: after such a
 * crash, every start for the next 30 s waits 20 s and gives up with "try again"; or, the other way, a live starter's
 * lock taken as stale, so two Inboxes write one store.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInboxStartLock, INBOX_START_LOCK, joinInboxStartLock } from "./registry";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-start-lock-"));
  roots.push(dir);
  return dir;
};

/** The pid of a process that has exited. */
function deadPid(): number {
  const run = Bun.spawnSync([process.execPath, "-e", "0"]);
  return run.pid;
}

test("a live holder keeps the lock; one whose holders are all gone is taken at once", () => {
  const dir = dataDir();
  const release = acquireInboxStartLock(dir)!;
  expect(release).toBeFunction();
  expect(readFileSync(join(dir, "inbox", INBOX_START_LOCK, "holders"), "utf8")).toBe(`${process.pid}\n`);
  expect(acquireInboxStartLock(dir)).toBeNull();
  release();

  // A start that crashed: its lock is fresh, but nobody it names runs.
  const crashed = dataDir();
  mkdirSync(join(crashed, "inbox", INBOX_START_LOCK), { recursive: true });
  writeFileSync(join(crashed, "inbox", INBOX_START_LOCK, "holders"), `${deadPid()}\n`);
  expect(acquireInboxStartLock(crashed)).toBeFunction();

  // The starter is gone but the Inbox it started (which joined) still runs: held.
  const handedOver = dataDir();
  mkdirSync(join(handedOver, "inbox", INBOX_START_LOCK), { recursive: true });
  writeFileSync(join(handedOver, "inbox", INBOX_START_LOCK, "holders"), `${deadPid()}\n`);
  joinInboxStartLock(handedOver);
  expect(acquireInboxStartLock(handedOver)).toBeNull();

  // An older Plannotator's lock names nobody: fresh is held, as before.
  const older = dataDir();
  mkdirSync(join(older, "inbox", INBOX_START_LOCK), { recursive: true });
  expect(acquireInboxStartLock(older)).toBeNull();
});
