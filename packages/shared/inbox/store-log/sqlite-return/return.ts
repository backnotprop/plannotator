/// <reference types="bun-types" />
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { inboxDir as inboxDirOf } from "../../schema";
import { jsonlInboxLog } from "../jsonl-log";
import { exportInboxDb } from "./export";
import { freeBackupName, fsyncPath, JSONL_ENTRIES, moveIntoBackup, readMeta, readOnly, syncTree, withDb } from "./files";
import { INBOX_DB_FILE, INBOX_RETURN_PARTIAL } from "./names";

export { INBOX_DB_FILE, INBOX_RETURN_PARTIAL };

const LEFTOVERS = ["inbox.db.importing", "inbox.db.importing-wal", "inbox.db.importing-shm", "inbox.db.importing-journal", "inbox-upgrading.pid"];

export type InboxReturnStep = "exported" | "marked" | "entry" | "placed";

export interface InboxReturnOptions {
  now?: () => Date;
  step?: (name: InboxReturnStep) => void;
}

export class InboxReturnError extends Error {}

export function inboxReturnFailedWords(dataDir: string): string {
  const db = join(inboxDirOf(dataDir), INBOX_DB_FILE);
  let bytes = 0;
  for (const file of [db, `${db}-wal`]) bytes += existsSync(file) ? statSync(file).size : 0;
  const mb = Math.max(1, Math.ceil(bytes / 1e6));
  return `The Inbox could not start: its messages are in ${db}, they are safe, and nothing was changed. Free about ${mb} MB of disk, then run plannotator inbox again.`;
}

export function inboxReturnDelayFromEnv(env: Record<string, string | undefined>): ((name: InboxReturnStep) => void) | undefined {
  const ms = env.PLANNOTATOR_TEST_SANDBOX ? Number(env.PLANNOTATOR_INBOX_RETURN_DELAY_MS) : 0;
  if (!Number.isSafeInteger(ms) || ms <= 0) return undefined;
  return (name) => {
    if (name !== "exported") return;
    process.stderr.write(`Inbox: the way back held ${ms} ms in ${process.pid}\n`);
    Bun.sleepSync(ms);
  };
}

export function returnFromSqlite(dataDir: string, options: InboxReturnOptions = {}): { lines: number; ms: number } | null {
  const inboxDir = inboxDirOf(dataDir);
  for (const name of LEFTOVERS) if (existsSync(join(inboxDir, name))) rmSync(join(inboxDir, name), { force: true });
  const db = join(inboxDir, INBOX_DB_FILE);
  if (!existsSync(db)) return null;
  const started = performance.now();
  const now = options.now ?? (() => new Date());
  const partial = join(inboxDir, INBOX_RETURN_PARTIAL);
  let lines = 0;
  let exporting = false;
  let backup: string | null;
  try {
    backup = readMeta(db, "returned_backup");
    if (!backup) {
      exporting = true;
      rmSync(partial, { recursive: true, force: true });
      if (JSONL_ENTRIES.some((entry) => existsSync(join(inboxDir, entry)))) moveIntoBackup(inboxDir, freeBackupName(inboxDir, now(), "jsonl"));
      const exported = exportInboxDb(db, partial);
      lines = exported.lines;
      options.step?.("exported");
      const back = jsonlInboxLog(partial).read();
      if (back.lines.length !== exported.lines || back.seqFloor !== exported.seqFloor) {
        throw new Error(`the files read back ${back.lines.length} of ${exported.lines} lines`);
      }
      syncTree(partial);
      const name = freeBackupName(inboxDir, now(), "sqlite");
      withDb(db, (marked) => {
        marked.run("PRAGMA synchronous = FULL");
        marked.run("INSERT INTO meta (key, value) VALUES ('returned_backup', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [name]);
        marked.run("PRAGMA wal_checkpoint(TRUNCATE)");
      });
      backup = name;
      options.step?.("marked");
    }
  } catch (error) {
    if (exporting) rmSync(partial, { recursive: true, force: true });
    throw new InboxReturnError(`${inboxReturnFailedWords(dataDir)} (${error instanceof Error ? error.message : String(error)})`);
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
