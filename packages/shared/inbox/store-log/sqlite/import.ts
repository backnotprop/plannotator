/// <reference types="bun-types" />
/**
 * Moving an Inbox from today's JSONL files into `inbox.db` (design brief "The Inbox on SQLite", section 5), with
 * zero loss: NOT wired to users; nothing calls it outside its test until the store's default log changes.
 *
 * 1. A complete `inbox.db` is there: finish moving the files into the backup if a crash stopped that, and stop.
 * 2. A half-written `inbox.db.importing` from a crash is removed; the files were only ever read.
 * 3. Too little free disk (under 2.5x the files): keep running on the files.
 * 4. Read the files with today's exact rules (the JSONL log's own reader: torn lines, unknown kinds, the seq
 *    floor), write every line in seq order into `inbox.db.importing` (`writeLine`: the same writer as a live append).
 * 5. Verify: open the store over the files and over the new database, and compare a SHA-256 of everything as the
 *    app serves it (`digest.ts`). Any difference, or any failure: remove the new file, keep running on the files,
 *    and leave a report of the counts (no words) beside them.
 * 6. `integrity_check`, mark the database complete, rename it to `inbox.db` (atomic).
 * 7. Move the files into `backup-<date>-jsonl/`, read-only; never removed automatically. One rename per entry, so
 *    a crash midway is finished by the next start (step 1).
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir as inboxDirOf, INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE } from "../../schema";
import { InboxStore } from "../../store";
import { jsonlInboxLog } from "../jsonl-log";
import { inboxStoreDigest } from "./digest";
import { INBOX_DB_FILE, keepSeqFloor, openInboxDb, sqliteInboxLog } from "./sqlite-log";
import { writeLine } from "./write-line";

export const INBOX_DB_IMPORTING = `${INBOX_DB_FILE}.importing`;

/** The entries of today's record files under `inbox/`: what the import reads and then moves into the backup. */
const JSONL_ENTRIES = [INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE];

/** Lines written per transaction: one transaction per line would make the import minutes long at 100k. */
const BATCH = 2_000;

export type InboxImportOutcome =
  /** `inbox.db` was already the record (the backup's move finished if a crash had stopped it). */
  | { status: "already" }
  /** No files to move: a new Inbox starts on the database. */
  | { status: "empty" }
  | { status: "imported"; lines: number; ms: number; backup: string }
  /** The files keep serving: not enough disk, a check that differed, or a failure while writing. */
  | { status: "kept_files"; reason: "disk" | "mismatch" | "failed"; detail: string };

export interface InboxImportOptions {
  now?: () => Date;
  /** Free bytes where the inbox lives (tests). */
  freeBytes?: (dir: string) => number;
  /** Test-only: change the new database after it is written and before it is checked. */
  afterWrite?: (db: Database) => void;
}

/** Move the Inbox under `dataDir` from its JSONL files into `inbox.db`, or say why the files keep serving. */
export function importJsonlInbox(dataDir: string, options: InboxImportOptions = {}): InboxImportOutcome {
  const now = options.now ?? (() => new Date());
  const inboxDir = inboxDirOf(dataDir);
  const target = join(inboxDir, INBOX_DB_FILE);
  if (existsSync(target)) {
    const backup = readMeta(target, "import_backup");
    if (backup) moveIntoBackup(inboxDir, backup);
    return { status: "already" };
  }
  removeDb(join(inboxDir, INBOX_DB_IMPORTING));
  const present = JSONL_ENTRIES.filter((entry) => existsSync(join(inboxDir, entry)));
  if (present.length === 0) return { status: "empty" };

  const size = present.reduce((sum, entry) => sum + bytesUnder(join(inboxDir, entry)), 0);
  const free = (options.freeBytes ?? freeBytesAt)(inboxDir);
  if (free < size * 2.5) return { status: "kept_files", reason: "disk", detail: `${free} bytes free, ${Math.ceil(size * 2.5)} needed` };

  const started = performance.now();
  const importing = join(inboxDir, INBOX_DB_IMPORTING);
  try {
    // Today's exact rules: the JSONL log's own reader, then the store's order (seq; equal seqs in read order).
    const { lines, seqFloor } = jsonlInboxLog(inboxDir).read();
    lines!.sort((a, b) => a.seq - b.seq);
    const { sqlite, db } = openInboxDb(inboxDir, INBOX_DB_IMPORTING);
    try {
      for (let i = 0; i < lines!.length; i += BATCH) {
        db.transaction((tx) => {
          for (const line of lines!.slice(i, i + BATCH)) writeLine(tx, line);
        });
      }
      keepSeqFloor(db, seqFloor);
      options.afterWrite?.(sqlite);
    } finally {
      sqlite.close();
    }

    // The check: everything as the app serves it, from the files and from the new database.
    const fromFiles = inboxStoreDigest(InboxStore.open(dataDir, { now, log: jsonlInboxLog }));
    const opened: { close(): void }[] = [];
    let fromDb;
    try {
      fromDb = inboxStoreDigest(
        InboxStore.open(dataDir, {
          now,
          log: (dir) => {
            const log = sqliteInboxLog(dir, INBOX_DB_IMPORTING);
            opened.push(log);
            return log;
          },
        }),
      );
    } finally {
      // Closed before the file is renamed: no connection may write beside the old name afterwards.
      for (const log of opened) log.close();
    }
    if (fromFiles.sha256 !== fromDb.sha256) {
      removeDb(importing);
      writeReport(inboxDir, now(), { files: fromFiles.counts, database: fromDb.counts });
      return { status: "kept_files", reason: "mismatch", detail: "the new database reads differently from the files" };
    }

    const backup = `backup-${now().toISOString().slice(0, 10)}-jsonl`;
    const check = new Database(importing, { strict: true });
    try {
      const integrity = check.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
      if (integrity?.integrity_check !== "ok") throw new Error(`integrity_check: ${integrity?.integrity_check}`);
      check.run("INSERT INTO meta (key, value) VALUES ('import_backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [backup]);
      check.run("INSERT INTO meta (key, value) VALUES ('import_complete', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [now().toISOString()]);
      check.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      check.close();
    }
    removeSidecars(importing);
    renameSync(importing, target);
    moveIntoBackup(inboxDir, backup);
    return { status: "imported", lines: lines!.length, ms: Math.round(performance.now() - started), backup };
  } catch (error) {
    removeDb(importing);
    return { status: "kept_files", reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Move what is still in place into the backup folder, read-only; each entry one rename, so it can run again. */
function moveIntoBackup(inboxDir: string, name: string): void {
  const backup = join(inboxDir, name);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const entry of JSONL_ENTRIES) {
    const from = join(inboxDir, entry);
    if (!existsSync(from)) continue;
    renameSync(from, join(backup, entry));
    readOnly(join(backup, entry));
  }
}

/** Each file read-only; folders stay the owner's, so Settings → Storage's Remove can delete the backup. */
function readOnly(path: string): void {
  if (!statSync(path).isDirectory()) return chmodSync(path, 0o400);
  for (const child of readdirSync(path)) readOnly(join(path, child));
}

function bytesUnder(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, child) => sum + bytesUnder(join(path, child)), 0);
}

function freeBytesAt(dir: string): number {
  const stat = statfsSync(dir);
  return Number(stat.bavail) * Number(stat.bsize);
}

function readMeta(file: string, key: string): string | null {
  const db = new Database(file, { readonly: true, strict: true });
  try {
    return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function removeSidecars(file: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${file}${suffix}`, { force: true });
}

function removeDb(file: string): void {
  rmSync(file, { force: true });
  removeSidecars(file);
}

/** Why an import kept the files: per-kind and per-thread counts from each side, no words. */
function writeReport(inboxDir: string, at: Date, counts: unknown): void {
  try {
    writeFileSync(join(inboxDir, `import-check-${at.toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify(counts, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Best effort: the files keep serving either way.
  }
}
