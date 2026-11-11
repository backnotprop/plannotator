/// <reference types="bun-types" />
/**
 * The SQLite record log: the same promises as today's JSONL log (`../log.ts`), kept in `<dataDir>/inbox/inbox.db`
 * with Bun's built-in SQLite and Drizzle. NOT wired to users: nothing opens it unless a caller hands
 * `sqliteInboxLog` to `InboxStore.open` (the tests do). No import from the JSONL files, no flag.
 *
 * Every append is one transaction (the change-log row and the record's current row together), synchronous, so
 * the store stays the one writer it is today. WAL with `synchronous=NORMAL`: a power cut may lose the last
 * commits, never corrupt the file (no worse than today's unsynced appends). Tables are STRICT (a migration
 * edit; Drizzle does not write it), so a wrong type is refused rather than stored.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { InboxCard, InboxLine, InboxProject } from "@plannotator/core/inbox-types";
import type { InboxLog, InboxLogContents, InboxLogUsage } from "../log";
import { lineBytes, lineOfRow } from "./line-row";
import { migrateInboxDb } from "./migrations";
import * as t from "./schema";
import { type InboxDb, writeLine } from "./write-line";

export const INBOX_DB_FILE = "inbox.db";

/** Kinds whose rows belong to a thread (Settings → Storage counts them per thread). */
const THREAD_KINDS = ["message", "question", "annotation", "steps", "thread_pull"];

export function sqliteInboxLog(dir: string): InboxLog {
  return new SqliteInboxLog(dir);
}

/** Open (and bring up to date) the Inbox database in `dir`. */
export function openInboxDb(dir: string): { sqlite: Database; db: InboxDb } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sqlite = new Database(join(dir, INBOX_DB_FILE), { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA busy_timeout = 5000");
  const db = drizzle({ client: sqlite });
  migrateInboxDb(db);
  // Fold a long write-ahead log back into the file before the start's one big read.
  sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
  return { sqlite, db };
}

class SqliteInboxLog implements InboxLog {
  private readonly db: InboxDb;
  private readonly sqlite: Database;

  constructor(dir: string) {
    ({ db: this.db, sqlite: this.sqlite } = openInboxDb(dir));
  }

  read(): InboxLogContents {
    const lines: InboxLine[] = [];
    // The whole log, streamed row by row (plain SQL: the one bulk read, where Drizzle's row objects only cost memory).
    for (const row of this.sqlite.query("SELECT seq, at, v, kind, subject_id, data FROM events ORDER BY seq").iterate()) {
      const line = lineOfRow(row);
      if (line) lines.push(line);
    }
    return { lines, seqFloor: this.seqFloor() };
  }

  append(line: InboxLine, _project: InboxProject | null): void {
    this.db.transaction((tx) => writeLine(tx, line));
  }

  keyTaken(key: string): boolean {
    return this.db.select({ id: t.projects.id }).from(t.projects).where(and(eq(t.projects.key, key), isNull(t.projects.deleted_at))).get() !== undefined;
  }

  createProject(_project: InboxProject, line: InboxLine): void {
    this.db.transaction((tx) => writeLine(tx, line));
  }

  deleteThread(_project: InboxProject, threadId: string, messageIds: ReadonlySet<string>, seq: number): void {
    const ids = [...messageIds];
    const at = new Date().toISOString();
    this.db.transaction((tx) => {
      keepFloor(tx, seq);
      tx.delete(t.events)
        .where(or(eq(t.events.thread_id, threadId), and(eq(t.events.kind, "question"), inArray(t.events.message_id, ids))))
        .run();
      const questionIds = tx.select({ id: t.questions.id }).from(t.questions).where(inArray(t.questions.message_id, ids)).all().map((q) => q.id);
      tx.delete(t.answers).where(inArray(t.answers.question_id, questionIds)).run();
      tx.delete(t.questions).where(inArray(t.questions.message_id, ids)).run();
      tx.delete(t.attachments).where(inArray(t.attachments.message_id, ids)).run();
      tx.delete(t.mentions).where(inArray(t.mentions.message_id, ids)).run();
      tx.delete(t.messages).where(eq(t.messages.thread_id, threadId)).run();
      tx.delete(t.readState).where(eq(t.readState.thread_id, threadId)).run();
      tx.delete(t.annotations).where(eq(t.annotations.thread_id, threadId)).run();
      tx.delete(t.steps).where(eq(t.steps.thread_id, threadId)).run();
      tx.delete(t.threadPulls).where(eq(t.threadPulls.thread_id, threadId)).run();
      // The tombstone: the thread's id and when it went, no words.
      tx.update(t.threads).set({ thread_name: null, deleted_at: at }).where(eq(t.threads.id, threadId)).run();
    });
  }

  deleteProject(project: InboxProject, seq: number): void {
    const at = new Date().toISOString();
    this.db.transaction((tx) => {
      keepFloor(tx, seq);
      const messageIds = tx.select({ id: t.messages.id }).from(t.messages).where(eq(t.messages.project_id, project.id)).all().map((m) => m.id);
      const questionIds = tx.select({ id: t.questions.id }).from(t.questions).where(eq(t.questions.project_id, project.id)).all().map((q) => q.id);
      tx.delete(t.events).where(eq(t.events.project_id, project.id)).run();
      tx.delete(t.answers).where(inArray(t.answers.question_id, questionIds)).run();
      tx.delete(t.questions).where(eq(t.questions.project_id, project.id)).run();
      tx.delete(t.attachments).where(inArray(t.attachments.message_id, messageIds)).run();
      tx.delete(t.mentions).where(inArray(t.mentions.message_id, messageIds)).run();
      tx.delete(t.readState).where(inArray(t.readState.thread_id, tx.select({ id: t.threads.id }).from(t.threads).where(eq(t.threads.project_id, project.id)))).run();
      tx.delete(t.messages).where(eq(t.messages.project_id, project.id)).run();
      for (const table of [t.annotations, t.cards, t.steps, t.threadPulls]) tx.delete(table).where(eq(table.project_id, project.id)).run();
      tx.update(t.threads).set({ thread_name: null, deleted_at: at }).where(eq(t.threads.project_id, project.id)).run();
      tx.update(t.projects).set({ deleted_at: at, record: "{}" }).where(eq(t.projects.id, project.id)).run();
    });
  }

  cardLines(_project: InboxProject, cardId: string): { seq: number; card: InboxCard }[] {
    const rows = this.db.select().from(t.events).where(and(eq(t.events.kind, "card"), eq(t.events.subject_id, cardId))).all();
    return rows.flatMap((row) => {
      const line = lineOfRow(row);
      return line?.kind === "card" ? [{ seq: line.seq, card: line.record }] : [];
    });
  }

  usage(project: InboxProject): InboxLogUsage {
    let bytes = 0;
    const lines: InboxLogUsage["lines"] = [];
    for (const row of this.db.select().from(t.events).where(eq(t.events.project_id, project.id)).all()) {
      const line = lineOfRow(row);
      if (!line) continue;
      const size = lineBytes(line);
      bytes += size;
      if (THREAD_KINDS.includes(line.kind)) lines.push({ line, bytes: size });
    }
    return { bytes, lines };
  }

  private seqFloor(): number {
    const row = this.db.select({ value: t.meta.value }).from(t.meta).where(eq(t.meta.key, "seq_floor")).get();
    const value = Number(row?.value ?? 0);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }
}

function keepFloor(db: Parameters<typeof writeLine>[0], seq: number): void {
  db.insert(t.meta)
    .values({ key: "seq_floor", value: String(seq) })
    .onConflictDoUpdate({ target: t.meta.key, set: { value: sql`cast(max(cast(${t.meta.value} as integer), ${seq}) as text)` } })
    .run();
}
