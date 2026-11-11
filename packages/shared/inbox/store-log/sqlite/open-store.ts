/// <reference types="bun-types" />
/**
 * Which record log an Inbox starts on. An explicit switch always wins; unset means new installs only (an Inbox with
 * `inbox.db` or with record files stays as it is, one with neither starts on SQLite). Runs before the server listens.
 */
import { existsSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { INBOX_PROJECTS_DIR, inboxDir } from "../../schema";
import { InboxStore } from "../../store";
import { importJsonlInbox, type InboxImportOutcome, type InboxImportStep } from "./import";
import { INBOX_DB_IMPORTING, jsonlEntriesPresent, readMeta, removeDb } from "./move-files";
import { returnToJsonl, type InboxReturnOutcome } from "./return-to-files";
import { INBOX_DB_FILE, sqliteInboxLog } from "./sqlite-log";
import { clearStaleUpgradeMarker } from "./upgrade-marker";

/** `null` is unset. */
export type InboxSqliteSwitch = boolean | null;

/** The env var wins over the config's `inboxSqlite`; anything else is unset. */
export function resolveInboxSqlite(config: { inboxSqlite?: unknown }, env: Record<string, string | undefined>): InboxSqliteSwitch {
  const raw = env.PLANNOTATOR_INBOX_SQLITE?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (config.inboxSqlite === true || config.inboxSqlite === false) return config.inboxSqlite;
  return null;
}

export type InboxLogWhy = "switch_on" | "switch_off" | "database" | "files" | "new_install";

/** Reads only. An `inbox.db` keeps serving unless a way back to the files is past its point of no return. */
export function chooseInboxLog(dataDir: string, sqlite: InboxSqliteSwitch): { sqlite: boolean; why: InboxLogWhy } {
  if (sqlite === true) return { sqlite: true, why: "switch_on" };
  if (sqlite === false) return { sqlite: false, why: "switch_off" };
  const dir = inboxDir(dataDir);
  const db = join(dir, INBOX_DB_FILE);
  if (existsSync(db)) return readMeta(db, "returned_backup") ? { sqlite: false, why: "files" } : { sqlite: true, why: "database" };
  if (jsonlEntriesPresent(dir).some((entry) => entry !== INBOX_PROJECTS_DIR || !emptyFolder(join(dir, entry)))) return { sqlite: false, why: "files" };
  return { sqlite: true, why: "new_install" };
}

export interface OpenedInboxStore {
  store: InboxStore;
  log: "jsonl" | "sqlite";
  why: InboxLogWhy;
  moved?: InboxImportOutcome | InboxReturnOutcome;
}

export interface OpenInboxStoreOptions {
  sqlite: InboxSqliteSwitch;
  now?: () => Date;
  /** Called once when a move runs past 2 s. */
  onSlow?: () => void;
  /** Test-only: at each of the move's step boundaries. */
  importStep?: (name: InboxImportStep) => void;
  /** This program, for the move's check in a second process. */
  checkFilesCommand?: readonly string[];
}

/**
 * Test-only: honored only under `PLANNOTATOR_TEST_SANDBOX`.
 * - `PLANNOTATOR_INBOX_IMPORT_DELAY_MS`: hold a move this long once it has read the files.
 * - `PLANNOTATOR_INBOX_IMPORT_STOP_AT=<step>[:<n>]`: SIGKILL the process the n-th time the move reaches `<step>`.
 */
export function inboxImportDelayFromEnv(env: Record<string, string | undefined>): ((name: InboxImportStep) => void) | undefined {
  if (!env.PLANNOTATOR_TEST_SANDBOX) return undefined;
  const raw = env.PLANNOTATOR_INBOX_IMPORT_DELAY_MS?.trim();
  const ms = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  const delay = Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
  const [stopAt, nth] = (env.PLANNOTATOR_INBOX_IMPORT_STOP_AT?.trim() ?? "").split(":");
  const stopNth = nth && /^\d+$/.test(nth) ? Number(nth) : 1;
  if (!delay && !stopAt) return undefined;
  let seen = 0;
  return (name) => {
    if (delay && name === "read") Bun.sleepSync(delay);
    if (stopAt && name === stopAt && ++seen === stopNth) process.kill(process.pid, "SIGKILL");
  };
}

export async function openInboxStore(dataDir: string, options: OpenInboxStoreOptions): Promise<OpenedInboxStore> {
  const { now } = options;
  const dir = inboxDir(dataDir);
  const db = join(dir, INBOX_DB_FILE);
  const jsonl = () => InboxStore.open(dataDir, now ? { now } : {});
  const sqlite = () => InboxStore.open(dataDir, { ...(now ? { now } : {}), log: sqliteInboxLog });
  const { sqlite: on, why } = chooseInboxLog(dataDir, options.sqlite);
  if (!on) {
    // A crashed move leaves a half file nothing will read.
    const half = join(dir, INBOX_DB_IMPORTING);
    if (existsSync(half)) {
      removeDb(half);
      clearStaleUpgradeMarker(dir);
    }
    if (!existsSync(db)) return { store: jsonl(), log: "jsonl", why };
    const moved = returnToJsonl(dataDir, { now });
    return moved.status === "kept_db" ? { store: sqlite(), log: "sqlite", why, moved } : { store: jsonl(), log: "jsonl", why, moved };
  }
  // An empty `projects` folder would otherwise be moved into a backup.
  if (why === "new_install" && emptyFolder(join(dir, INBOX_PROJECTS_DIR))) removeEmptyFolder(join(dir, INBOX_PROJECTS_DIR));
  // A crashed way back is past its point of no return: finish it first.
  if (existsSync(db) && readMeta(db, "returned_backup")) returnToJsonl(dataDir, { now });
  const moved = await importJsonlInbox(dataDir, { now, onSlow: options.onSlow, step: options.importStep, checkFilesCommand: options.checkFilesCommand });
  if (moved.status === "kept_files") return { store: jsonl(), log: "jsonl", why, moved };
  return { store: sqlite(), log: "sqlite", why, moved };
}

function emptyFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function removeEmptyFolder(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Something was written into it meanwhile: it stays.
  }
}
