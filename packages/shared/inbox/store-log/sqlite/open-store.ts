/// <reference types="bun-types" />
/**
 * Which record log an Inbox starts on. The switch (`inboxSqlite` / `PLANNOTATOR_INBOX_SQLITE`, `resolveInboxSqlite`)
 * has three states, and an explicit one always wins:
 *
 * - Unset (the default): new installs only. An Inbox with `inbox.db` stays on it; one with record files stays on
 *   them; one with neither (nothing was ever written: a new install, an older version's empty folder, a folder the
 *   person deleted) starts on SQLite. Nothing moves either way, so there is no backup. The choice is remembered by
 *   what it leaves on disk: the database, or the files.
 * - Off: today's JSONL store. With no `inbox.db`, exactly as before (two `existsSync`; a half file a crashed move
 *   left is removed). With one (the switch was on, or the Inbox started on SQLite): everything goes back into the
 *   files (`return-to-files.ts`), messages written on SQLite included, and the files serve. If that cannot be done
 *   safely, the database keeps serving: switching off never hides or loses a message.
 * - On: the files move into `inbox.db` (`import.ts`) when there is no database yet, then the database serves. A
 *   move that cannot finish (too little disk, a check that differs, a failure) leaves the files serving.
 *
 * While the database serves, a note named `projects` stands where the files were (`files-marker.ts`), so an older
 * Plannotator stops at it instead of starting an empty Inbox.
 *
 * Runs before the server listens, as today's load does.
 */
import { existsSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { INBOX_PROJECTS_DIR, inboxDir } from "../../schema";
import { InboxStore } from "../../store";
import { removeSqliteMarker, writeSqliteMarker } from "./files-marker";
import { importJsonlInbox, type InboxImportOutcome, type InboxImportStep } from "./import";
import { INBOX_DB_IMPORTING, jsonlEntriesPresent, readMeta, removeDb } from "./move-files";
import { returnToJsonl, type InboxReturnOutcome } from "./return-to-files";
import { INBOX_DB_FILE, sqliteInboxLog } from "./sqlite-log";
import { clearStaleUpgradeMarker } from "./upgrade-marker";

/** The switch: on, off, or unset (`null`: new installs start on SQLite, every other Inbox stays as it is). */
export type InboxSqliteSwitch = boolean | null;

/**
 * The switch: `PLANNOTATOR_INBOX_SQLITE` (`1`/`true`/`on`, `0`/`false`/`off`) wins, else the config's `inboxSqlite`
 * (`true` / `false`); anything else is unset.
 */
export function resolveInboxSqlite(config: { inboxSqlite?: unknown }, env: Record<string, string | undefined>): InboxSqliteSwitch {
  const raw = env.PLANNOTATOR_INBOX_SQLITE?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (config.inboxSqlite === true || config.inboxSqlite === false) return config.inboxSqlite;
  return null;
}

/** Why this start serves the log it does (the debug log's `store_load` notes it). */
export type InboxLogWhy = "switch_on" | "switch_off" | "database" | "files" | "new_install";

/**
 * The log the Inbox under `dataDir` starts on, and why. An explicit switch wins. Unset: an `inbox.db` keeps serving
 * (unless a way back to the files is past its point of no return: that finishes); record files keep serving; with
 * neither, a new install starts on SQLite. Reads only.
 */
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
  /** The log the store reads and writes. */
  log: "jsonl" | "sqlite";
  /** Why this log (`chooseInboxLog`). */
  why: InboxLogWhy;
  /** What moving between them did at this start, when anything was to move. */
  moved?: InboxImportOutcome | InboxReturnOutcome;
}

export interface OpenInboxStoreOptions {
  /** The switch: on, off, or unset (`null`: new installs only). */
  sqlite: InboxSqliteSwitch;
  now?: () => Date;
  /** Called once when a move runs past 2 s: the "Upgrading your Inbox…" line. */
  onSlow?: () => void;
  /** Test-only: at each of the move's step boundaries (`importJsonlInbox`'s `step`). */
  importStep?: (name: InboxImportStep) => void;
  /** This program, for the move's check in a second process (`importJsonlInbox`'s `checkFilesCommand`). */
  checkFilesCommand?: readonly string[];
}

/**
 * Test-only, under the test sandbox only (`PLANNOTATOR_TEST_SANDBOX`), for proofs on a real start of the compiled
 * binary (`scripts/inbox-sqlite-binary-proof.ts`). Anywhere else, nothing.
 * - `PLANNOTATOR_INBOX_IMPORT_DELAY_MS`: hold a move this long once it has read the files, so a real start can be
 *   seen outlasting a starter's wait.
 * - `PLANNOTATOR_INBOX_IMPORT_STOP_AT=<step>[:<n>]`: the process kills itself, hard (SIGKILL; on Windows the same
 *   call is TerminateProcess), the n-th time the move reaches `<step>` (`InboxImportStep`): a crash at an exact point.
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
  const opened = await openChosen(dataDir, options);
  // The note an older Plannotator stops at stands exactly while the database serves (`files-marker.ts`).
  if (opened.log === "sqlite") writeSqliteMarker(inboxDir(dataDir));
  else removeSqliteMarker(inboxDir(dataDir));
  return opened;
}

async function openChosen(dataDir: string, options: OpenInboxStoreOptions): Promise<OpenedInboxStore> {
  const { now } = options;
  const dir = inboxDir(dataDir);
  const db = join(dir, INBOX_DB_FILE);
  const jsonl = () => InboxStore.open(dataDir, now ? { now } : {});
  const sqlite = () => InboxStore.open(dataDir, { ...(now ? { now } : {}), log: sqliteInboxLog });
  const { sqlite: on, why } = chooseInboxLog(dataDir, options.sqlite);
  if (!on) {
    // A move the switch started and a crash stopped leaves a half file nothing will read: removed.
    const half = join(dir, INBOX_DB_IMPORTING);
    if (existsSync(half)) {
      removeDb(half);
      clearStaleUpgradeMarker(dir);
    }
    if (!existsSync(db)) return { store: jsonl(), log: "jsonl", why };
    const moved = returnToJsonl(dataDir, { now });
    return moved.status === "kept_db" ? { store: sqlite(), log: "sqlite", why, moved } : { store: jsonl(), log: "jsonl", why, moved };
  }
  // A new install: an empty `projects` folder (nothing was ever written in it) goes, so nothing moves into a backup.
  if (why === "new_install" && emptyFolder(join(dir, INBOX_PROJECTS_DIR))) removeEmptyFolder(join(dir, INBOX_PROJECTS_DIR));
  // A way back that a crash stopped finishes first (it is past its point of no return); then the files move again.
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
    // Something was written into it meanwhile: it stays, and the move below takes it as records.
  }
}
