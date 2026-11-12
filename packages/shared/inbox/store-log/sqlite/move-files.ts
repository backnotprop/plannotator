/// <reference types="bun-types" />
/**
 * The file moves the import (`import.ts`) and the way back to the files (`return-to-files.ts`) share: the record
 * entries under `inbox/`, the dated backup folders they go into (one rename per entry, so a crash midway is
 * finished by the next start), reading a database's `meta` without opening it for writing, removing a database
 * with its side files, and syncing a file or folder to disk.
 */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE } from "../../schema";

/** The database while the import writes it: renamed to `inbox.db` once checked; a leftover is a crash's, removed. */
export const INBOX_DB_IMPORTING = "inbox.db.importing";

/** The entries of today's record files under `inbox/`: what the import reads and then moves into the backup. */
export const JSONL_ENTRIES = [INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE];

/** A backup folder's name: `backup-<date>-<what>`, then `-2`, `-3` when one of that day is already there. */
export function freeBackupName(inboxDir: string, at: Date, what: "jsonl" | "sqlite"): string {
  const base = `backup-${at.toISOString().slice(0, 10)}-${what}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(join(inboxDir, name))) return name;
  }
}

/** Flush a file or folder to disk; best effort for a folder (not every system opens one). */
export function fsyncPath(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!statSync(path).isDirectory()) throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Move what is still in place into the backup folder, read-only; each entry one rename, so it can run again. */
export function moveIntoBackup(inboxDir: string, name: string, moved?: () => void): void {
  const backup = join(inboxDir, name);
  for (const entry of JSONL_ENTRIES) {
    const from = join(inboxDir, entry);
    if (!existsSync(from)) continue;
    // Made only when something moves: a backup the person removed is never made again, empty, at the next start.
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    renameSync(from, join(backup, entry));
    readOnly(join(backup, entry));
    moved?.();
  }
}

/** Each file read-only; folders stay the owner's, so Settings → Storage's Remove can delete the backup. */
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

export function removeSidecars(file: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${file}${suffix}`, { force: true });
}

export function removeDb(file: string): void {
  rmSync(file, { force: true });
  removeSidecars(file);
}

