/// <reference types="bun-types" />
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE } from "../../schema";

/** The database while the import writes it; a leftover is a crash's. */
export const INBOX_DB_IMPORTING = "inbox.db.importing";

/** The record entries under `inbox/` that move into a backup. */
export const JSONL_ENTRIES = [INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE];

export function jsonlEntriesPresent(inboxDir: string): string[] {
  return JSONL_ENTRIES.filter((entry) => existsSync(join(inboxDir, entry)));
}

/** `backup-<date>-<what>`, then `-2`, `-3` when that day's is taken. */
export function freeBackupName(inboxDir: string, at: Date, what: "jsonl" | "sqlite"): string {
  const base = `backup-${at.toISOString().slice(0, 10)}-${what}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(join(inboxDir, name))) return name;
  }
}

/** Best effort for a folder (not every system opens one). A file is opened for writing: Windows flushes only through a writable handle (read-only fails with EPERM). */
export function fsyncPath(path: string): void {
  let fd: number | null = null;
  const folder = statSync(path).isDirectory();
  try {
    fd = openSync(path, folder ? "r" : "r+");
    fsyncSync(fd);
  } catch (error) {
    if (!folder) throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** One rename per entry, so a crash midway is finished by running it again. */
export function moveIntoBackup(inboxDir: string, name: string, moved?: () => void): void {
  const backup = join(inboxDir, name);
  for (const entry of jsonlEntriesPresent(inboxDir)) {
    const from = join(inboxDir, entry);
    // Made only when something moves: a backup the person removed is never made again, empty, at the next start.
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    renameSync(from, join(backup, entry));
    readOnly(join(backup, entry));
    moved?.();
  }
}

/** Files read-only; folders stay writable so the backup can be deleted. */
export function readOnly(path: string): void {
  if (!statSync(path).isDirectory()) return chmodSync(path, 0o400);
  for (const child of readdirSync(path)) readOnly(join(path, child));
}

export function bytesUnder(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, child) => sum + bytesUnder(join(path, child)), 0);
}

export function readMeta(file: string, key: string): string | null {
  // Read-write, never created: a database in WAL mode with no side files cannot be opened read-only.
  const db = new Database(file, { readwrite: true, create: false, strict: true });
  try {
    return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Windows refuses to remove a file another process still holds open (EBUSY, EPERM); retried for about 3 s. */
const RETRY = { force: true, maxRetries: 15, retryDelay: 200 } as const;

export function removeSidecars(file: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${file}${suffix}`, RETRY);
}

export function removeDb(file: string): void {
  rmSync(file, RETRY);
  removeSidecars(file);
}

