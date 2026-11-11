/// <reference types="bun-types" />
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { inboxDir as inboxDirOf } from "../../schema";
import { jsonlInboxLog } from "../jsonl-log";
import { checkDigests } from "./check";
import { exportInboxDb } from "./export";
import { freeBackupName, fsyncPath, JSONL_ENTRIES, moveIntoBackup, readMeta, readOnly } from "./move-files";
import { INBOX_DB_FILE, sqliteInboxLog } from "./sqlite-log";

export const INBOX_RETURN_PARTIAL = "jsonl-return.partial";

export type InboxReturnOutcome =
  | { status: "none" }
  | { status: "returned"; lines: number; ms: number; backup: string }
  /** The database keeps serving; nothing moved. */
  | { status: "kept_db"; reason: "mismatch" | "failed"; detail: string };

export interface InboxReturnOptions {
  now?: () => Date;
  /** Test-only: at each step boundary. */
  step?: (name: "exported" | "marked" | "entry" | "placed") => void;
}

/** Move the Inbox under `dataDir` from `inbox.db` back into its JSONL files, or say why the database keeps serving. */
export function returnToJsonl(dataDir: string, options: InboxReturnOptions = {}): InboxReturnOutcome {
  const now = options.now ?? (() => new Date());
  const inboxDir = inboxDirOf(dataDir);
  const db = join(inboxDir, INBOX_DB_FILE);
  const partial = join(inboxDir, INBOX_RETURN_PARTIAL);
  if (!existsSync(db)) return { status: "none" };
  const started = performance.now();
  let lines = 0;
  let backup = readMeta(db, "returned_backup");
  if (!backup) {
    try {
      const importBackup = readMeta(db, "import_backup");
      if (importBackup) moveIntoBackup(inboxDir, importBackup);
      rmSync(partial, { recursive: true, force: true });
      ({ lines } = exportInboxDb(db, partial));
      options.step?.("exported");
      const check = checkDigests(dataDir, now, { log: () => jsonlInboxLog(partial) }, { log: sqliteInboxLog });
      if (!check.same) {
        rmSync(partial, { recursive: true, force: true });
        return { status: "kept_db", reason: "mismatch", detail: "the exported files read differently from the database" };
      }
      syncTree(partial);
      backup = freeBackupName(inboxDir, now(), "sqlite");
      const marked = new Database(db, { strict: true });
      try {
        marked.run("PRAGMA synchronous = FULL");
        marked.run("INSERT INTO meta (key, value) VALUES ('returned_backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [backup]);
        marked.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        marked.close();
      }
      options.step?.("marked");
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      return { status: "kept_db", reason: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  // Past the mark: the next start finishes whatever stops this.
  for (const entry of JSONL_ENTRIES) {
    const from = join(partial, entry);
    if (!existsSync(from) || existsSync(join(inboxDir, entry))) continue;
    renameSync(from, join(inboxDir, entry));
    options.step?.("entry");
  }
  rmSync(partial, { recursive: true, force: true });
  fsyncPath(inboxDir);
  options.step?.("placed");
  const folder = join(inboxDir, backup);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  checkpoint(db);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(`${db}${suffix}`)) renameSync(`${db}${suffix}`, join(folder, `${INBOX_DB_FILE}${suffix}`));
  renameSync(db, join(folder, INBOX_DB_FILE));
  readOnly(folder);
  fsyncPath(inboxDir);
  return { status: "returned", lines, ms: Math.round(performance.now() - started), backup };
}

function checkpoint(file: string): void {
  const db = new Database(file, { strict: true });
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function syncTree(dir: string): void {
  for (const child of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, child.name);
    if (child.isDirectory()) syncTree(path);
    fsyncPath(path);
  }
  fsyncPath(dir);
}
