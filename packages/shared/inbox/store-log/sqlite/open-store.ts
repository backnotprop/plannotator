/// <reference types="bun-types" />
/**
 * Which record log an Inbox starts on, behind the SQLite switch (`inboxSqlite` / `PLANNOTATOR_INBOX_SQLITE`, off by
 * default and for everyone; `resolveInboxSqlite` in `../../../config.ts`).
 *
 * - Off, and no `inbox.db`: today's JSONL store, exactly as before (two `existsSync`; a half file a crashed move
 *   left is removed).
 * - Off, with an `inbox.db` (the switch was on, then turned off): everything goes back into the files
 *   (`return-to-files.ts`), messages written on SQLite included, and the files serve. If that cannot be done
 *   safely, the database keeps serving: switching off never hides or loses a message.
 * - On: the files move into `inbox.db` (`import.ts`) when there is no database yet, then the database serves. A
 *   move that cannot finish (too little disk, a check that differs, a failure) leaves the files serving.
 *
 * Runs before the server listens, as today's load does.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "../../schema";
import { InboxStore } from "../../store";
import { importJsonlInbox, type InboxImportOutcome, type InboxImportStep } from "./import";
import { INBOX_DB_IMPORTING, readMeta, removeDb } from "./move-files";
import { returnToJsonl, type InboxReturnOutcome } from "./return-to-files";
import { INBOX_DB_FILE, sqliteInboxLog } from "./sqlite-log";
import { clearStaleUpgradeMarker } from "./upgrade-marker";

/** The switch: `PLANNOTATOR_INBOX_SQLITE` (`1`/`true`/`on`, `0`/`false`/`off`) wins, else the config's `inboxSqlite: true`. Off by default. */
export function resolveInboxSqlite(config: { inboxSqlite?: unknown }, env: Record<string, string | undefined>): boolean {
  const raw = env.PLANNOTATOR_INBOX_SQLITE?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return config.inboxSqlite === true;
}

export interface OpenedInboxStore {
  store: InboxStore;
  /** The log the store reads and writes. */
  log: "jsonl" | "sqlite";
  /** What moving between them did at this start, when anything was to move. */
  moved?: InboxImportOutcome | InboxReturnOutcome;
}

export interface OpenInboxStoreOptions {
  /** The switch. */
  sqlite: boolean;
  now?: () => Date;
  /** Called once when a move runs past 2 s: the "Upgrading your Inbox…" line. */
  onSlow?: () => void;
  /** Test-only: at each of the move's step boundaries (`importJsonlInbox`'s `step`). */
  importStep?: (name: InboxImportStep) => void;
  /** This program, for the move's check in a second process (`importJsonlInbox`'s `checkFilesCommand`). */
  checkFilesCommand?: readonly string[];
}

/**
 * Test-only, under the test sandbox only: `PLANNOTATOR_INBOX_IMPORT_DELAY_MS` holds a move this long once it has read
 * the files, so a real start can be seen outlasting a starter's wait. Anywhere else, nothing.
 */
export function inboxImportDelayFromEnv(env: Record<string, string | undefined>): ((name: InboxImportStep) => void) | undefined {
  const raw = env.PLANNOTATOR_TEST_SANDBOX ? env.PLANNOTATOR_INBOX_IMPORT_DELAY_MS?.trim() : undefined;
  const ms = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(ms) || ms <= 0) return undefined;
  return (name) => {
    if (name === "read") Bun.sleepSync(ms);
  };
}

export async function openInboxStore(dataDir: string, options: OpenInboxStoreOptions): Promise<OpenedInboxStore> {
  const { now } = options;
  const db = join(inboxDir(dataDir), INBOX_DB_FILE);
  const jsonl = () => InboxStore.open(dataDir, now ? { now } : {});
  const sqlite = () => InboxStore.open(dataDir, { ...(now ? { now } : {}), log: sqliteInboxLog });
  if (!options.sqlite) {
    // A move the switch started and a crash stopped leaves a half file nothing will read: removed.
    const half = join(inboxDir(dataDir), INBOX_DB_IMPORTING);
    if (existsSync(half)) {
      removeDb(half);
      clearStaleUpgradeMarker(inboxDir(dataDir));
    }
    if (!existsSync(db)) return { store: jsonl(), log: "jsonl" };
    const moved = returnToJsonl(dataDir, { now });
    return moved.status === "kept_db" ? { store: sqlite(), log: "sqlite", moved } : { store: jsonl(), log: "jsonl", moved };
  }
  // A way back that a crash stopped finishes first (it is past its point of no return); then the files move again.
  if (existsSync(db) && readMeta(db, "returned_backup")) returnToJsonl(dataDir, { now });
  const moved = await importJsonlInbox(dataDir, { now, onSlow: options.onSlow, step: options.importStep, checkFilesCommand: options.checkFilesCommand });
  if (moved.status === "kept_files") return { store: jsonl(), log: "jsonl", moved };
  return { store: sqlite(), log: "sqlite", moved };
}
