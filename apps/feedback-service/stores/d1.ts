import type { FeedbackEntry, FeedbackStore } from "../core/storage";

const NO_AGENTS_COLUMN = /no column named agents/i;

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
