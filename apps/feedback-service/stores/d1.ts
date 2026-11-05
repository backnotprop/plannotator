import type { FeedbackEntry, FeedbackStore } from "../core/storage";

/** A table made before migrations/0001_agents.sql has no `agents` column: SQLite says so when it prepares the INSERT. */
const NO_AGENTS_COLUMN = /no column named agents/i;

/**
 * The D1-backed store. Its statements are parameterised INSERTs into the
 * append-only `feedback` table (schema.sql): the one that writes every column,
 * and the same without `agents` for a table the migration has not reached yet.
 * test/source-guard.test.ts fails if any other kind of statement appears in
 * the Worker's source.
 */
export class D1FeedbackStore implements FeedbackStore {
  constructor(private db: D1Database) {}

  async insert(entry: FeedbackEntry): Promise<void> {
    try {
      await this.db
        .prepare(
          `INSERT INTO feedback (message, category, contact, version, os, surface, agents, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          entry.message,
          entry.category,
          entry.contact,
          entry.version,
          entry.os,
          entry.surface,
          entry.agents,
          entry.created_at
        )
        .run();
    } catch (error) {
      // Deployed before the migration: the statement is refused before any row exists, so writing the
      // feedback without the agent names cannot make a second row. Anything else is the caller's 500.
      if (!NO_AGENTS_COLUMN.test(error instanceof Error ? error.message : String(error))) throw error;
      await this.db
        .prepare(
          `INSERT INTO feedback (message, category, contact, version, os, surface, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(entry.message, entry.category, entry.contact, entry.version, entry.os, entry.surface, entry.created_at)
        .run();
    }
  }
}
