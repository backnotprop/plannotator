/**
 * File helpers for a store several processes write (an agent's CLI, the Inbox server): JSON written atomically,
 * append-only JSON lines that survive a torn last line, and a per-folder lock file. The thread canvas's store
 * uses them.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STORE_LOCK_WAIT_MS = 5000;
export const STORE_LOCK_STALE_MS = 30_000;

// The lock is a file holding its owner's token. A lock older than
// STORE_LOCK_STALE_MS is broken, but only under a second lock (`.lock.break`) and
// only if it is still stale when looked at again there, so two waiters can
// never both break it and each take a fresh lock. The owner removes the lock
// only while it still holds its own token. `sleep` blocks the thread: the
// store is called from the CLI, one command per process; a server that calls
// it must call it off its event loop.
function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function readLines<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn line from a crash mid-append: skipped.
    }
  }
  return out;
}

/** Append one line; when the file's last line is torn, start on a new one so both stay readable. */
export function appendLine(path: string, value: unknown) {
  let prefix = "";
  try {
    const size = statSync(path).size;
    if (size > 0) {
      const text = readFileSync(path, "utf8");
      if (!text.endsWith("\n")) prefix = "\n";
    }
  } catch {
    // a new file
  }
  appendFileSync(path, `${prefix}${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function lockAge(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function breakIfStale(lock: string) {
  if ((lockAge(lock) ?? 0) <= STORE_LOCK_STALE_MS) return;
  const breaker = `${lock}.break`;
  let fd: number;
  try {
    fd = openSync(breaker, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A breaker that died mid-break: its lock goes the same way, later.
    if ((lockAge(breaker) ?? 0) > STORE_LOCK_STALE_MS) rmSync(breaker, { force: true });
    return;
  }
  try {
    if ((lockAge(lock) ?? 0) > STORE_LOCK_STALE_MS) rmSync(lock, { force: true });
  } finally {
    closeSync(fd);
    rmSync(breaker, { force: true });
  }
}

/** Run `fn` holding `dir`/.lock; `label` names the store in the error when the lock stays taken. */
export function withLock<T>(dir: string, fn: () => T, label = "store"): T {
  const lock = join(dir, ".lock");
  const token = `${process.pid}.${randomUUID()}`;
  const start = Date.now();
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      breakIfStale(lock);
      if (Date.now() - start > STORE_LOCK_WAIT_MS) throw new Error(`${label}: ${dir} stayed locked for ${STORE_LOCK_WAIT_MS} ms`);
      sleep(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
    } catch {
      // broken as stale while we held it, or the folder is gone (remove)
    }
  }
}
