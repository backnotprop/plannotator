/// <reference path="./sql-text.d.ts" />
/// <reference types="bun-types" />
/**
 * The Inbox database's migrations, carried inside the program: each `migration.sql` drizzle-kit wrote is
 * imported as text, so `bun build --compile` embeds it and the binary needs no migrations folder on disk.
 * Drizzle's migrator (1.0) takes the list in memory and records what ran in `__drizzle_migrations`.
 *
 * A new migration: `drizzle.config.ts` says how to generate it; add STRICT to its new tables, then one line
 * below, oldest first. `timestamp` is the folder's leading time (the order Drizzle applies them in).
 */
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { InboxDb } from "./write-line";
import records from "./migrations/20261111105042_inbox_records/migration.sql" with { type: "text" };

export const INBOX_DB_MIGRATIONS = [{ name: "20261111105042_inbox_records", timestamp: Date.UTC(2026, 10, 11, 10, 50, 42), sql: records }];

/**
 * Two processes opening a new file at the same moment (two Inboxes starting on a new install) can both find it
 * unmigrated: each runs the migration in its own transaction, and the second's first CREATE fails once the first
 * has committed. It is the same migration, so the loser runs again, finds it recorded, and skips it.
 */
export function migrateInboxDb(db: InboxDb): void {
  for (let attempt = 0; ; attempt++) {
    try {
      migrate(db, INBOX_DB_MIGRATIONS);
      return;
    } catch (error) {
      if (attempt >= 20 || !raced(error)) throw error;
      Bun.sleepSync(20 + attempt * 20);
    }
  }
}

function raced(error: unknown): boolean {
  const text = `${error instanceof Error ? error.message : String(error)} ${error instanceof Error && error.cause ? String(error.cause) : ""}`;
  return /already exists|database is locked|SQLITE_BUSY/i.test(text);
}
