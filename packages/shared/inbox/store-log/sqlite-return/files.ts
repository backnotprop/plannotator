/// <reference types="bun-types" />
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE } from "../../schema";

export const JSONL_ENTRIES = [INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE];

export function freeBackupName(inboxDir: string, at: Date, kind: "jsonl" | "sqlite"): string {
  const base = `backup-${at.toISOString().slice(0, 10)}-${kind}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(join(inboxDir, name))) return name;
  }
}

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

export function syncTree(dir: string): void {
  for (const child of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, child.name);
    if (child.isDirectory()) syncTree(path);
    fsyncPath(path);
  }
  fsyncPath(dir);
}

export function moveIntoBackup(inboxDir: string, name: string): void {
  const backup = join(inboxDir, name);
  for (const entry of JSONL_ENTRIES) {
    const from = join(inboxDir, entry);
    if (!existsSync(from)) continue;
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    renameSync(from, join(backup, entry));
    readOnly(join(backup, entry));
  }
}

export function readOnly(path: string): void {
  if (!statSync(path).isDirectory()) return chmodSync(path, 0o400);
  for (const child of readdirSync(path)) readOnly(join(path, child));
}

export function withDb<T>(file: string, use: (db: Database) => T): T {
  const db = new Database(file, { readwrite: true, create: false, strict: true });
  try {
    return use(db);
  } finally {
    db.close();
  }
}

export function readMeta(file: string, key: string): string | null {
  return withDb(file, (db) => db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null);
}
