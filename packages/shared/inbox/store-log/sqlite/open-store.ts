/// <reference types="bun-types" />
/**
 * Which record log an Inbox starts on, behind the SQLite switch (`inboxSqlite` / `PLANNOTATOR_INBOX_SQLITE`, off by
 * default and for everyone; `resolveInboxSqlite` in `../../../config.ts`).
 *
 * - Off, and no `inbox.db`: today's JSONL store, exactly as before (one `existsSync`).
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
import { importJsonlInbox, type InboxImportOutcome } from "./import";
import { readMeta } from "./move-files";
import { returnToJsonl, type InboxReturnOutcome } from "./return-to-files";
import { INBOX_DB_FILE, sqliteInboxLog } from "./sqlite-log";

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
}

export async function openInboxStore(dataDir: string, options: OpenInboxStoreOptions): Promise<OpenedInboxStore> {
  const { now } = options;
  const db = join(inboxDir(dataDir), INBOX_DB_FILE);
  const jsonl = () => InboxStore.open(dataDir, now ? { now } : {});
  const sqlite = () => InboxStore.open(dataDir, { ...(now ? { now } : {}), log: sqliteInboxLog });
  if (!options.sqlite) {
    if (!existsSync(db)) return { store: jsonl(), log: "jsonl" };
    const moved = returnToJsonl(dataDir, { now });
    return moved.status === "kept_db" ? { store: sqlite(), log: "sqlite", moved } : { store: jsonl(), log: "jsonl", moved };
  }
  // A way back that a crash stopped finishes first (it is past its point of no return); then the files move again.
  if (existsSync(db) && readMeta(db, "returned_backup")) returnToJsonl(dataDir, { now });
  const moved = await importJsonlInbox(dataDir, { now, onSlow: options.onSlow });
  if (moved.status === "kept_files") return { store: jsonl(), log: "jsonl", moved };
  return { store: sqlite(), log: "sqlite", moved };
}
