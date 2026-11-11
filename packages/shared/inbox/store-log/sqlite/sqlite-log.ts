/// <reference types="bun-types" />
/**
 * The SQLite record log: the same promises as today's JSONL log (`../log.ts`), kept in `<dataDir>/inbox/inbox.db`
 * with Bun's built-in SQLite and Drizzle. NOT wired to users: nothing opens it unless a caller hands
 * `sqliteInboxLog` to `InboxStore.open` (the tests do). No import from the JSONL files, no flag.
 *
 * Every append is one transaction (the change-log row, the record's current row and the facts its order gives),
 * synchronous, so the store stays the one writer it is today. A start reads current state from the tables
 * (`read`), never the change log. WAL with `synchronous=NORMAL`: a power cut may lose the last
 * commits, never corrupt the file (no worse than today's unsynced appends). Tables are STRICT (a migration
 * edit; Drizzle does not write it), so a wrong type is refused rather than stored.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { InboxCard, InboxLine, InboxProject } from "@plannotator/core/inbox-types";
import type { InboxThreadPullEvent } from "../../store";
import type { InboxLog, InboxLogContents, InboxLogState, InboxLogUsage } from "../log";
import { lineBytes, lineOfRow } from "./line-row";
import { migrateInboxDb } from "./migrations";
import * as t from "./schema";
import { type InboxDb, writeLine } from "./write-line";

export const INBOX_DB_FILE = "inbox.db";

/** Kinds whose rows belong to a thread (Settings → Storage counts them per thread). */
const THREAD_KINDS = ["message", "question", "annotation", "steps", "thread_pull"];

/** The SQLite log over `<dir>/<file>` (`file`: the import writes `inbox.db.importing` first). `close()` lets go of the file. */
export function sqliteInboxLog(dir: string, file: string = INBOX_DB_FILE): InboxLog & { close(): void } {
  return new SqliteInboxLog(dir, file);
}

/** Open (and bring up to date) the Inbox database `file` in `dir`. */
export function openInboxDb(dir: string, file: string = INBOX_DB_FILE): { sqlite: Database; db: InboxDb } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sqlite = new Database(join(dir, file), { create: true, strict: true });
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

  constructor(dir: string, file: string) {
    ({ db: this.db, sqlite: this.sqlite } = openInboxDb(dir, file));
  }

  close(): void {
    this.sqlite.close();
  }

  read(): InboxLogContents {
    return { state: this.state(), seqFloor: this.seqFloor() };
  }

  /**
   * Current state from the tables: each record's latest line (its row, with the time and version of the line that
   * wrote it), in the order the records began, and the facts kept as they happened. Plain SQL: the one bulk read,
   * streamed row by row, where Drizzle's row objects would only cost memory.
   */
  private state(): InboxLogState {
    const latest = (kind: string, table: string, where = "") =>
      `SELECT '${kind}' AS kind, r.id AS subject_id, r.record AS data, r.first_seq AS first_seq, e.seq AS seq, e.at AS at, e.v AS v FROM ${table} r JOIN events e ON e.kind = '${kind}' AND e.subject_id = r.id AND e.seq = r.seq ${where}`;
    const sql = [
      latest("project", "projects", "WHERE r.deleted_at IS NULL"),
      latest("message", "messages"),
      latest("question", "questions"),
      latest("annotation", "annotations"),
      latest("card", "cards"),
      latest("steps", "steps"),
      latest("thread_pull", "thread_pulls"),
      latest("initiative", "initiatives"),
    ].join(" UNION ALL ");
    const records: InboxLogState["records"] = [];
    for (const row of this.sqlite.query<{ first_seq: number }, []>(`${sql} ORDER BY first_seq`).iterate()) {
      const line = lineOfRow(row);
      if (line) records.push({ line, firstSeq: row.first_seq });
    }
    const archiveSeq = new Map<string, number>();
    const readdressed = new Set<string>();
    for (const row of this.sqlite.query<{ id: string; resolved_seq: number | null; readdressed: number }, []>("SELECT id, resolved_seq, readdressed FROM threads WHERE deleted_at IS NULL AND (resolved_seq IS NOT NULL OR readdressed = 1)").iterate()) {
      if (row.resolved_seq !== null) archiveSeq.set(row.id, row.resolved_seq);
      if (row.readdressed) readdressed.add(row.id);
    }
    const names = this.sqlite
      .query<{ projectId: string; name: string; rootId: string; routes: number }, []>("SELECT project_id AS projectId, name, root_id AS rootId, routes FROM thread_names ORDER BY seq")
      .all()
      .map((row) => ({ ...row, routes: row.routes === 1 }));
    const tags = this.sqlite.query<{ key: string; threadId: string; seq: number }, []>("SELECT tag_key AS key, thread_id AS threadId, seq FROM message_tags ORDER BY seq").all();
    const cards = new Map<string, { card: InboxCard; heardSeq: number }>();
    for (const row of this.sqlite.query<{ id: string; card: string; heard_seq: number }, []>("SELECT id, card, heard_seq FROM cards").iterate()) {
      cards.set(row.id, { card: JSON.parse(row.card) as InboxCard, heardSeq: row.heard_seq });
    }
    const pullEvents = new Map<string, InboxThreadPullEvent[]>();
    for (const row of this.sqlite.query<{ thread_id: string; event: string }, []>("SELECT thread_id, event FROM thread_pull_events ORDER BY seq, id").iterate()) {
      const events = pullEvents.get(row.thread_id);
      const event = JSON.parse(row.event) as InboxThreadPullEvent;
      if (events) events.push(event);
      else pullEvents.set(row.thread_id, [event]);
    }
    return { records, archiveSeq, readdressed, names, tags, cards, pullEvents };
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
      keepSeqFloor(tx, seq);
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
      tx.delete(t.threadPullEvents).where(eq(t.threadPullEvents.thread_id, threadId)).run();
      tx.delete(t.threadNames).where(eq(t.threadNames.root_id, threadId)).run();
      tx.delete(t.messageTags).where(eq(t.messageTags.thread_id, threadId)).run();
      // The tombstone: the thread's id and when it went, no words.
      tx.update(t.threads).set({ thread_name: null, resolved_seq: null, readdressed: false, deleted_at: at }).where(eq(t.threads.id, threadId)).run();
    });
  }

  deleteProject(project: InboxProject, seq: number): void {
    const at = new Date().toISOString();
    this.db.transaction((tx) => {
      keepSeqFloor(tx, seq);
      const messageIds = tx.select({ id: t.messages.id }).from(t.messages).where(eq(t.messages.project_id, project.id)).all().map((m) => m.id);
      const questionIds = tx.select({ id: t.questions.id }).from(t.questions).where(eq(t.questions.project_id, project.id)).all().map((q) => q.id);
      tx.delete(t.events).where(eq(t.events.project_id, project.id)).run();
      tx.delete(t.answers).where(inArray(t.answers.question_id, questionIds)).run();
      tx.delete(t.questions).where(eq(t.questions.project_id, project.id)).run();
      tx.delete(t.attachments).where(inArray(t.attachments.message_id, messageIds)).run();
      tx.delete(t.mentions).where(inArray(t.mentions.message_id, messageIds)).run();
      tx.delete(t.readState).where(inArray(t.readState.thread_id, tx.select({ id: t.threads.id }).from(t.threads).where(eq(t.threads.project_id, project.id)))).run();
      tx.delete(t.messages).where(eq(t.messages.project_id, project.id)).run();
      for (const table of [t.annotations, t.cards, t.steps, t.threadPulls, t.threadPullEvents, t.threadNames, t.messageTags]) tx.delete(table).where(eq(table.project_id, project.id)).run();
      tx.update(t.threads).set({ thread_name: null, resolved_seq: null, readdressed: false, deleted_at: at }).where(eq(t.threads.project_id, project.id)).run();
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

/** Raise the seq floor to `seq` (never lower it). */
export function keepSeqFloor(db: Parameters<typeof writeLine>[0], seq: number): void {
  db.insert(t.meta)
    .values({ key: "seq_floor", value: String(seq) })
    .onConflictDoUpdate({ target: t.meta.key, set: { value: sql`cast(max(cast(${t.meta.value} as integer), ${seq}) as text)` } })
    .run();
}
