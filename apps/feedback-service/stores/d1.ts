import type { FeedbackEntry, FeedbackStore } from "../core/storage";

/**
 * The D1-backed store. Its one statement is a parameterised INSERT into the
 * append-only `feedback` table (schema.sql). test/source-guard.test.ts fails
 * if any other kind of statement appears in the Worker's source.
 */
export class D1FeedbackStore implements FeedbackStore {
  constructor(private db: D1Database) {}

  async insert(entry: FeedbackEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO feedback (message, category, contact, version, os, surface, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        entry.message,
        entry.category,
        entry.contact,
        entry.version,
        entry.os,
        entry.surface,
        entry.created_at
      )
      .run();
  }
}
