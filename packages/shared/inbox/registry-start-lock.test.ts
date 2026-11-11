/** `acquireInboxStartLock`: a crashed starter's lock does not block the next start; a live starter's lock is never taken as stale. */
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

  const older = dataDir();
  mkdirSync(join(older, "inbox", INBOX_START_LOCK), { recursive: true });
  expect(acquireInboxStartLock(older)).toBeNull();
});
