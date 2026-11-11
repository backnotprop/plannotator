/// <reference path="./sql-text.d.ts" />
/// <reference types="bun-types" />
/**
 * Each `migration.sql` is imported as text so `bun build --compile` embeds it. A new migration: generate it
 * (`drizzle.config.ts`), add STRICT to its new tables, then one line below, oldest first; `timestamp` is the
 * folder's leading time.
 */
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { InboxDb } from "./write-line";
import records from "./migrations/20261111105042_inbox_records/migration.sql" with { type: "text" };

export const INBOX_DB_MIGRATIONS = [{ name: "20261111105042_inbox_records", timestamp: Date.UTC(2026, 10, 11, 10, 50, 42), sql: records }];

/** Two Inboxes starting on a new file can both run the migration; the loser's CREATE fails, so it retries and finds it recorded. */
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
