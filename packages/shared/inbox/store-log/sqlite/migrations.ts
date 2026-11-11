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
import records from "./migrations/20261111104000_inbox_records/migration.sql" with { type: "text" };

export const INBOX_DB_MIGRATIONS = [{ name: "20261111104000_inbox_records", timestamp: Date.UTC(2026, 10, 11, 10, 40, 0), sql: records }];

export function migrateInboxDb(db: InboxDb): void {
  migrate(db, INBOX_DB_MIGRATIONS);
}
