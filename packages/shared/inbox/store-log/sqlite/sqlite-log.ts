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
import { isInboxInitiativeRecord, isInboxStepsRecord, isInboxThreadPullRecord, type InboxCard, type InboxLine, type InboxProject } from "@plannotator/core/inbox-types";
import type { InboxThreadPullEvent } from "../../store";
import type { InboxLog, InboxLogContents, InboxLogState, InboxLogUsage, InboxStoreBackup } from "../log";
import { listInboxBackups, removeInboxBackup } from "./backups";
import { lineBytes, lineOfRow } from "./line-row";
import { migrateInboxDb } from "./migrations";
import * as t from "./schema";
import { type InboxDb, writeLine } from "./write-line";

export const INBOX_DB_FILE = "inbox.db";

/** The kinds whose records the store checks as it places them: a failing one leaves the record before it. */
const KEPT_CHECKS: Partial<Record<InboxLine["kind"], (record: unknown) => boolean>> = {
  steps: isInboxStepsRecord,
  thread_pull: isInboxThreadPullRecord,
  initiative: isInboxInitiativeRecord,
};

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
  // First: another connection opening the file at the same moment (the import's check in its second process) holds
  // it for a moment while it sets up the write-ahead log, and every statement below waits that out instead of failing.
  sqlite.run("PRAGMA busy_timeout = 5000");
  // 8 KB pages for a new file (an existing one keeps its own): records are a few KB, and the import writes and
  // checks about a third faster than with 4 KB pages.
  sqlite.run("PRAGMA page_size = 8192");
  walMode(sqlite);
  sqlite.run("PRAGMA synchronous = NORMAL");
  const db = drizzle({ client: sqlite });
  migrateInboxDb(db);
  // Fold a long write-ahead log back into the file before the start's one big read.
  sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
  return { sqlite, db };
}

/**
 * Into WAL. Switching a new file's journal needs it to itself, and SQLite answers "database is locked" at once
 * instead of waiting on the busy timeout when another process is opening the same new file (two Inboxes starting
 * together on a new install with the setting on): tried again for up to about 5 s.
 */
function walMode(sqlite: Database): void {
  for (let attempt = 0; ; attempt++) {
    try {
      sqlite.run("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (attempt >= 100 || (error as { code?: string }).code !== "SQLITE_BUSY") throw error;
      Bun.sleepSync(50);
    }
  }
}

class SqliteInboxLog implements InboxLog {
  private readonly db: InboxDb;
  private readonly sqlite: Database;
  private readonly file: string;

  constructor(
    private readonly dir: string,
    file: string,
  ) {
    this.file = join(dir, file);
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
    // The line that wrote the row: the last one at its seq (a line written twice, a retried append, is two rows).
    const latest = (kind: string, table: string, where = "") =>
      `SELECT '${kind}' AS kind, r.id AS subject_id, e.data AS data, r.first_seq AS first_seq, e.seq AS seq, e.at AS at, e.v AS v FROM ${table} r JOIN events e ON e.id = (SELECT max(x.id) FROM events x WHERE x.kind = '${kind}' AND x.subject_id = r.id AND x.seq = r.seq) ${where}`;
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
    for (const row of this.sqlite.query<{ first_seq: number }, []>(sql).iterate()) {
      const line = lineOfRow(row);
      if (line) records.push({ line, firstSeq: row.first_seq });
    }
    // Sorted here, not by SQLite: an ORDER BY would carry every record's text through its sorter.
    records.sort((a, b) => a.firstSeq - b.firstSeq);
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
    return { records, archiveSeq, readdressed, names, tags, cards, pullEvents, kept: this.keptRecords(records) };
  }

  /**
   * For each steps list, PR and initiative whose latest line fails its check, the last line before it that passes
   * (`apply` keeps that one): read from the change log, only for those few records.
   */
  private keptRecords(records: InboxLogState["records"]): Map<string, unknown> {
    const kept = new Map<string, unknown>();
    const history = this.sqlite.query<{ seq: number; at: string; v: number; kind: string; subject_id: string; data: string }, [string, string]>(
      "SELECT seq, at, v, kind, subject_id, data FROM events WHERE kind = ? AND subject_id = ? ORDER BY seq DESC, id DESC",
    );
    for (const { line } of records) {
      const check = KEPT_CHECKS[line.kind];
      if (!check || check(line.record)) continue;
      for (const row of history.iterate(line.kind, line.id)) {
        const earlier = lineOfRow(row);
        if (earlier && check(earlier.record)) {
          kept.set(`${line.kind}:${line.id}`, earlier.record);
          break;
        }
      }
    }
    return kept;
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
      tx.update(t.projects).set({ deleted_at: at }).where(eq(t.projects.id, project.id)).run();
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

  /**
   * Settings → Storage: what the database holds, the bytes of its rows and indexes (SQLite's `dbstat`; about 0.14 s
   * at 680 MB, read only when the panel asks), not the files' sizes. A Delete then makes the total fall by what it
   * removed, as on the JSONL files: counting the files, it rose with the log the delete writes, and counting pages,
   * a small thread's rows free no whole page. Without `dbstat`, the pages in use.
   */
  stored(): { bytes: number; backups: InboxStoreBackup[] } {
    let bytes: number;
    try {
      bytes = Number(this.sqlite.query<{ bytes: number | null }, []>("SELECT sum(payload) AS bytes FROM dbstat").get()?.bytes ?? 0);
    } catch {
      const pragma = (name: string) => Number(Object.values(this.sqlite.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0] ?? 0);
      bytes = pragma("page_size") * Math.max(0, pragma("page_count") - pragma("freelist_count"));
    }
    return { bytes, backups: listInboxBackups(this.dir) };
  }

  removeBackup(name: string): boolean {
    return removeInboxBackup(this.dir, name);
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
