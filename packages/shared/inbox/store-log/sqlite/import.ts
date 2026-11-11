/// <reference types="bun-types" />
/**
 * Moving an Inbox from today's JSONL files into `inbox.db` (design brief "The Inbox on SQLite", section 5), with
 * zero loss: NOT wired to users; nothing calls it outside its test until the store's default log changes.
 *
 * 1. A complete `inbox.db` is there: finish moving the files into the backup if a crash stopped that, and stop.
 * 2. A half-written `inbox.db.importing` from a crash is removed; the files were only ever read.
 * 3. Too little free disk (under 2.5x the files): keep running on the files.
 * 4. Read the files with today's exact rules (the JSONL log's own reader: torn lines, unknown kinds, the seq
 *    floor), work out every table's final rows in memory in seq order (`import-rows.ts`: the live writer's rules,
 *    `../history.ts`), and write them into `inbox.db.importing` in one pass (`import-load.ts`).
 * 5. Verify: open the store over the lines read and over the new database, and compare a SHA-256 of everything as
 *    the app serves it (`digest.ts`). Any difference, or any failure: remove the new file, keep running on the
 *    files, and leave a report of the counts (no words) beside them.
 * 6. `integrity_check`, mark the database complete, check the files did not change meanwhile, sync the file to
 *    disk and rename it to `inbox.db` (atomic), then sync the folder.
 * 7. Move the files into `backup-<date>-jsonl/`, read-only; never removed automatically. One rename per entry, so
 *    a crash midway is finished by the next start (step 1).
 */
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsync, openSync, readdirSync, renameSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir as inboxDirOf } from "../../schema";
import { jsonlInboxLog } from "../jsonl-log";
import type { InboxLog, InboxLogContents } from "../log";
import type { InboxLine } from "@plannotator/core/inbox-types";
import { checkDigests, digestOf, integrityOf } from "./check";
import { type FilesCheckProcess, filesDigest, spawnFilesCheck } from "./check-child";
import type { InboxStoreDigest } from "./digest";
import { loadImportRows } from "./import-load";
import { ImportRows } from "./import-rows";
import { INBOX_IMPORT_SLOW_MS } from "./move-words";
import { bytesUnder, freeBackupName, fsyncPath, INBOX_DB_IMPORTING, JSONL_ENTRIES, jsonlEntriesPresent, moveIntoBackup, readMeta, removeDb, removeSidecars } from "./move-files";
import { INBOX_DB_FILE, keepSeqFloor, openInboxDb, sqliteInboxLog } from "./sqlite-log";
import { clearStaleUpgradeMarker, clearUpgradeMarker, markUpgradeRunning } from "./upgrade-marker";

export { INBOX_DB_IMPORTING };



export type InboxImportOutcome =
  /** `inbox.db` was already the record (the backup's move finished if a crash had stopped it). */
  | { status: "already" }
  /** No files to move: a new Inbox starts on the database. */
  | { status: "empty" }
  /** `apart`: the files' side and the integrity check ran in the second process (`checkFilesCommand`), not here. */
  | { status: "imported"; lines: number; ms: number; backup: string; phases: InboxImportPhases; apart: boolean }
  /** The files keep serving: not enough disk, a check that differed, or a failure while writing. */
  | { status: "kept_files"; reason: "disk" | "mismatch" | "failed"; detail: string };

/** Where an import's time went, in ms (the debug log and the size budget print it). */
export interface InboxImportPhases {
  read: number;
  rows: number;
  load: number;
  integrity: number;
  checkFiles: number;
  checkDb: number;
  finish: number;
}

export interface InboxImportOptions {
  now?: () => Date;
  /** Free bytes where the inbox lives (tests). */
  freeBytes?: (dir: string) => number;
  /** Called once when the move runs past `slowAfterMs` (default 2 s): the "Upgrading your Inbox…" line. */
  onSlow?: () => void;
  slowAfterMs?: number;
  /** Test-only: the new database before its rows go in (a size limit for "disk full"). */
  beforeLoad?: (db: Database) => void;
  /** Test-only: change the new database after it is written and before it is checked. */
  afterWrite?: (db: Database) => void;
  /** Test-only: at each step boundary (the crash test kills the process there). */
  step?: (name: InboxImportStep) => void;
  /**
   * This program, to run the check's files side and integrity check in a second process beside the write
   * (`check-child.ts`; the Inbox passes its `selfCommand`). Without it, every step runs here, one after another.
   */
  checkFilesCommand?: readonly string[];
}

/** Move the Inbox under `dataDir` from its JSONL files into `inbox.db`, or say why the files keep serving. */
export async function importJsonlInbox(dataDir: string, options: InboxImportOptions = {}): Promise<InboxImportOutcome> {
  const now = options.now ?? (() => new Date());
  const step = options.step ?? (() => {});
  const inboxDir = inboxDirOf(dataDir);
  const target = join(inboxDir, INBOX_DB_FILE);
  clearStaleUpgradeMarker(inboxDir);
  if (existsSync(target)) {
    const backup = readMeta(target, "import_backup");
    if (backup) moveIntoBackup(inboxDir, backup, () => step("backup-entry"));
    return { status: "already" };
  }
  removeDb(join(inboxDir, INBOX_DB_IMPORTING));
  const present = jsonlEntriesPresent(inboxDir);
  if (present.length === 0) return { status: "empty" };

  const size = present.reduce((sum, entry) => sum + bytesUnder(join(inboxDir, entry)), 0);
  const free = (options.freeBytes ?? freeBytesAt)(inboxDir);
  if (free < size * 2.5) return { status: "kept_files", reason: "disk", detail: `${free} bytes free, ${Math.ceil(size * 2.5)} needed` };

  const started = performance.now();
  let slowTold = false;
  /** Called between steps and every few thousand lines: once the move has run past `slowAfterMs`, say so once. */
  const tick = () => {
    if (slowTold || !options.onSlow || performance.now() - started < (options.slowAfterMs ?? INBOX_IMPORT_SLOW_MS)) return;
    slowTold = true;
    options.onSlow();
  };
  const importing = join(inboxDir, INBOX_DB_IMPORTING);
  const phases: InboxImportPhases = { read: 0, rows: 0, load: 0, integrity: 0, checkFiles: 0, checkDb: 0, finish: 0 };
  let mark = started;
  const lap = (phase: keyof InboxImportPhases) => {
    const at = performance.now();
    phases[phase] = Math.round(at - mark);
    mark = at;
    tick();
  };
  /** The flush of the whole file, started once it is written: the disk works while this thread checks it. */
  let flushing: Promise<void> | null = null;
  let second: FilesCheckProcess | null = null;
  let lineCount = 0;
  let apart = false;
  // Starters wait for the move while this names a live process (`upgrade-marker.ts`).
  markUpgradeRunning(inboxDir);
  try {
    // Today's exact rules: the JSONL log's own reader, then the store's order (seq; equal seqs in read order).
    const sources = filesFingerprint(inboxDir);
    // The check's other half (the files' side, then the new file's integrity) in a second process, from now on.
    second = options.checkFilesCommand ? spawnFilesCheck(options.checkFilesCommand, dataDir, now()) : null;
    let contents: InboxLogContents | null = jsonlInboxLog(inboxDir).read();
    let lines: InboxLine[] | null = contents.lines!;
    lines.sort((a, b) => a.seq - b.seq);
    lineCount = lines.length;
    const seqFloor = contents.seqFloor;
    lap("read");
    step("read");
    // Every table's final rows, worked out once in memory, then written in one pass.
    let rows: ImportRows | null = new ImportRows();
    for (let i = 0; i < lines.length; i++) {
      rows.add(lines[i]!);
      if ((i & 4095) === 4095) tick();
    }
    lap("rows");
    step("rows");
    const { sqlite, db } = openInboxDb(inboxDir, INBOX_DB_IMPORTING);
    try {
      options.beforeLoad?.(sqlite);
      loadImportRows(sqlite, rows);
      keepSeqFloor(db, seqFloor);
      options.afterWrite?.(sqlite);
    } finally {
      sqlite.close();
    }
    rows = null;
    lap("load");
    step("load");
    // The file goes to disk on another thread while this one checks it: the two longest waits overlap.
    flushing = flushFile(importing);

    let check: { same: boolean; a: InboxStoreDigest; b: InboxStoreDigest };
    if (second) {
      // The files' side is the second process's: the lines read here are let go before the database's side is read.
      contents = null;
      lines = null;
      apart = true;
      const asked = await second.integrity(importing).catch(() => null);
      const dbSide = digestOf(dataDir, now, { log: (dir) => sqliteInboxLog(dir, INBOX_DB_IMPORTING) });
      lap("checkDb");
      // A second process that failed: its half done here.
      const here = () => {
        apart = false;
        return null;
      };
      const integrity = (asked ? await asked.answer.catch(here) : here()) ?? integrityOf(importing);
      if (integrity !== "ok") throw new Error(`integrity_check: ${integrity}`);
      lap("integrity");
      step("integrity");
      const filesSide = (await second.digest().catch(here)) ?? filesDigest(dataDir, now);
      lap("checkFiles");
      check = { same: filesSide.sha256 === dbSide.sha256, a: filesSide, b: dbSide };
    } else {
      const integrity = integrityOf(importing);
      if (integrity !== "ok") throw new Error(`integrity_check: ${integrity}`);
      lap("integrity");
      step("integrity");
      // The check: everything as the app serves it, from the files (the lines just read, replayed by the store)
      // and from the new database (read back from its tables).
      const read = contents;
      check = checkDigests(
        dataDir,
        now,
        { log: (dir) => readOnce(jsonlInboxLog(dir), read) },
        { log: (dir) => sqliteInboxLog(dir, INBOX_DB_IMPORTING) },
        () => lap("checkFiles"),
      );
      lap("checkDb");
    }
    step("checked");
    await flushing;
    if (!check.same) {
      removeDb(importing);
      writeReport(inboxDir, now(), { files: check.a.counts, database: check.b.counts });
      return { status: "kept_files", reason: "mismatch", detail: "the new database reads differently from the files" };
    }

    const backup = freeBackupName(inboxDir, now(), "jsonl");
    const finish = new Database(importing, { readwrite: true, create: false, strict: true });
    try {
      finish.run("PRAGMA busy_timeout = 5000");
      finish.run("PRAGMA synchronous = FULL");
      finish.run("INSERT INTO meta (key, value) VALUES ('import_backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [backup]);
      finish.run("INSERT INTO meta (key, value) VALUES ('import_complete', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [now().toISOString()]);
      finish.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      finish.close();
    }
    step("marked");
    // Something wrote to the files while they were moved (a second Inbox): the files keep serving, nothing is lost.
    if (filesFingerprint(inboxDir) !== sources) {
      removeDb(importing);
      return { status: "kept_files", reason: "mismatch", detail: "the files changed while they were moved" };
    }
    removeSidecars(importing);
    // On disk for good before it takes the real name (the pages above were flushed already): the rename is the switch.
    fsyncPath(importing);
    renameSync(importing, target);
    fsyncPath(inboxDir);
    step("renamed");
    moveIntoBackup(inboxDir, backup, () => step("backup-entry"));
    lap("finish");
    return { status: "imported", lines: lineCount, ms: Math.round(performance.now() - started), backup, phases, apart };
  } catch (error) {
    // A flush still running holds the file open: let it end before the file goes.
    await flushing?.catch(() => {});
    removeDb(importing);
    return { status: "kept_files", reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    second?.close();
    clearUpgradeMarker(inboxDir);
  }
}

/** The import's step boundaries (the crash test stops it at each one). */
export type InboxImportStep = "read" | "rows" | "load" | "integrity" | "checked" | "marked" | "renamed" | "backup-entry";

/**
 * Flush a file to disk on the I/O thread pool, so the caller can work meanwhile. The descriptor is opened here and
 * the flush handed over at once: a promise-based open would leave the flush itself waiting for this thread to be
 * free, which is after the checks it is meant to run beside.
 */
function flushFile(path: string): Promise<void> {
  // For writing: Windows flushes only through a handle that may write.
  const fd = openSync(path, "r+");
  return new Promise((resolve, reject) => {
    fsync(fd, (error) => {
      closeSync(fd);
      if (error) reject(error);
      else resolve();
    });
  });
}

/** A log that hands back contents already read once, then behaves as `log` (the check reads the same lines the import wrote). */
function readOnce(log: InboxLog, contents: InboxLogContents | null): InboxLog {
  let first = true;
  return Object.assign(Object.create(log) as InboxLog, {
    read(): InboxLogContents {
      if (!first || !contents) return log.read();
      first = false;
      return { lines: [...contents.lines!], seqFloor: contents.seqFloor };
    },
  });
}

/** Every record file's path, size and change time: a write during the move changes it. */
function filesFingerprint(inboxDir: string): string {
  const parts: string[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (!stat.isDirectory()) return void parts.push(`${path}:${stat.size}:${stat.mtimeMs}`);
    for (const child of readdirSync(path).sort()) walk(join(path, child));
  };
  for (const entry of JSONL_ENTRIES) walk(join(inboxDir, entry));
  return parts.join("\n");
}

function freeBytesAt(dir: string): number {
  const stat = statfsSync(dir);
  return Number(stat.bavail) * Number(stat.bsize);
}

/** Why an import kept the files: per-kind and per-thread counts from each side, no words. */
function writeReport(inboxDir: string, at: Date, counts: unknown): void {
  try {
    writeFileSync(join(inboxDir, `import-check-${at.toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify(counts, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Best effort: the files keep serving either way.
  }
}
