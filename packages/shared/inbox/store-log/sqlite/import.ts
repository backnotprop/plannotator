/// <reference types="bun-types" />
/**
 * Moves an Inbox from its JSONL files into `inbox.db` with zero loss: any difference or failure keeps the files
 * serving. The files go into `backup-<date>-jsonl/` one rename per entry, so the next start finishes a crashed move.
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
  | { status: "already" }
  | { status: "empty" }
  /** `apart`: the files' side and the integrity check ran in the second process (`checkFilesCommand`), not here. */
  | { status: "imported"; lines: number; ms: number; backup: string; phases: InboxImportPhases; apart: boolean }
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
  /** Called once when the move runs past `slowAfterMs` (default 2 s). */
  onSlow?: () => void;
  slowAfterMs?: number;
  /** Test-only: the new database before its rows go in (a size limit for "disk full"). */
  beforeLoad?: (db: Database) => void;
  /** Test-only: change the new database after it is written and before it is checked. */
  afterWrite?: (db: Database) => void;
  /** Test-only: at each step boundary (the crash test kills the process there). */
  step?: (name: InboxImportStep) => void;
  /** This program, to run the files side and integrity check in a second process; without it every step runs here. */
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
  /** Started once the file is written, so the disk works while this thread checks it. */
  let flushing: Promise<void> | null = null;
  let second: FilesCheckProcess | null = null;
  let lineCount = 0;
  let apart = false;
  markUpgradeRunning(inboxDir);
  try {
    const sources = filesFingerprint(inboxDir);
    second = options.checkFilesCommand ? spawnFilesCheck(options.checkFilesCommand, dataDir, now()) : null;
    let contents: InboxLogContents | null = jsonlInboxLog(inboxDir).read();
    let lines: InboxLine[] | null = contents.lines!;
    lines.sort((a, b) => a.seq - b.seq);
    lineCount = lines.length;
    const seqFloor = contents.seqFloor;
    lap("read");
    step("read");
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
    flushing = flushFile(importing);

    let check: { same: boolean; a: InboxStoreDigest; b: InboxStoreDigest };
    if (second) {
      // Let go of the lines read here before the database's side is read (memory).
      contents = null;
      lines = null;
      apart = true;
      const asked = await second.integrity(importing).catch(() => null);
      const dbSide = digestOf(dataDir, now, { log: (dir) => sqliteInboxLog(dir, INBOX_DB_IMPORTING) });
      lap("checkDb");
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
    // A second Inbox wrote to the files meanwhile.
    if (filesFingerprint(inboxDir) !== sources) {
      removeDb(importing);
      return { status: "kept_files", reason: "mismatch", detail: "the files changed while they were moved" };
    }
    removeSidecars(importing);
    // On disk before it takes the real name: the rename is the switch.
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

export type InboxImportStep = "read" | "rows" | "load" | "integrity" | "checked" | "marked" | "renamed" | "backup-entry";

/** Flush on the I/O thread pool. The descriptor is opened synchronously: a promise-based open would queue the flush behind the checks it should overlap. */
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

/** A log that hands back contents already read once, then behaves as `log`. */
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
