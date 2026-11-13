/// <reference types="bun-types" />
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { inboxDir as inboxDirOf } from "../../schema";
import { jsonlInboxLog } from "../jsonl-log";
import { exportInboxDb } from "./export";
import { freeBackupName, fsyncPath, JSONL_ENTRIES, moveIntoBackup, readMeta, readOnly, syncTree, withDb } from "./files";

export const INBOX_DB_FILE = "inbox.db";
export const INBOX_RETURN_PARTIAL = "jsonl-return.partial";

export type InboxReturnStep = "exported" | "marked" | "entry" | "placed";

export interface InboxReturnOptions {
  now?: () => Date;
  step?: (name: InboxReturnStep) => void;
}

export class InboxReturnError extends Error {}

export function returnFromSqlite(dataDir: string, options: InboxReturnOptions = {}): { lines: number; ms: number } | null {
  const inboxDir = inboxDirOf(dataDir);
  const db = join(inboxDir, INBOX_DB_FILE);
  if (!existsSync(db)) return null;
  const started = performance.now();
  const partial = join(inboxDir, INBOX_RETURN_PARTIAL);
  let lines = 0;
  let backup = readMeta(db, "returned_backup");
  if (!backup) {
    try {
      const importBackup = readMeta(db, "import_backup");
      if (importBackup) moveIntoBackup(inboxDir, importBackup);
      rmSync(partial, { recursive: true, force: true });
      const exported = exportInboxDb(db, partial);
      lines = exported.lines;
      options.step?.("exported");
      const back = jsonlInboxLog(partial).read();
      if (back.lines.length !== exported.lines || back.seqFloor !== exported.seqFloor) {
        throw new Error(`the files read back ${back.lines.length} of ${exported.lines} lines`);
      }
      syncTree(partial);
      backup = freeBackupName(inboxDir, (options.now ?? (() => new Date()))());
      const name = backup;
      withDb(db, (marked) => {
        marked.run("PRAGMA synchronous = FULL");
        marked.run("INSERT INTO meta (key, value) VALUES ('returned_backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [name]);
        marked.run("PRAGMA wal_checkpoint(TRUNCATE)");
      });
      options.step?.("marked");
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      throw new InboxReturnError(`Inbox: ${INBOX_DB_FILE} could not be moved back into its files; nothing changed (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
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
  withDb(db, (open) => open.run("PRAGMA wal_checkpoint(TRUNCATE)"));
  for (const suffix of ["-wal", "-shm"]) if (existsSync(`${db}${suffix}`)) renameSync(`${db}${suffix}`, join(folder, `${INBOX_DB_FILE}${suffix}`));
  renameSync(db, join(folder, INBOX_DB_FILE));
  readOnly(folder);
  fsyncPath(inboxDir);
  return { lines, ms: Math.round(performance.now() - started) };
}
