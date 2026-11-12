/**
 * The SQLite tables hold what the store holds, so the later stages can read them by query instead of
 * replaying the change log: each message's and question's current row points at the store's record, each thread's
 * message count and archive time match, the person's answer is one row in the state the question says
 * (picked, sent, withdrawn), a deleted thread is a tombstone with no words left, and the seq floor survives it.
 * The change log keeps each question's history of choices and Sends, with a run of typing kept as one row.
 *
 * The failures this guards: a row that drifts from the record it mirrors (a later query would serve stale
 * words or a wrong count), an answer that loses its state, a deletion that leaves a message behind, and a
 * decision history that drops a change of choice or a Send (or keeps every key typed).
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { InboxQuestionRecord } from "@plannotator/core/inbox-types";
import { InboxStore } from "../../store";
import { jsonlInboxLog } from "../jsonl-log";
import { teeLog } from "../tee-log";
import { writeInboxWorld } from "../world";
import { INBOX_DB_FILE, sqliteInboxLog } from "./sqlite-log";

/** A current row's record: the change-log line it points at (its kind, id and seq; the last such row). */
const CURRENT = (kind: string, r: string) => `(SELECT e.data FROM events e WHERE e.kind = '${kind}' AND e.subject_id = ${r}.id AND e.seq = ${r}.seq ORDER BY e.id DESC LIMIT 1) AS record`;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("every message, question, answer and thread row matches the store's record; a deleted thread is a tombstone", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-sqlite-tables-"));
  roots.push(dataDir);
  const world = writeInboxWorld({ dataDir, seed: 7, steps: 260, log: teeLog(jsonlInboxLog, sqliteInboxLog) });
  const store = InboxStore.open(dataDir, { now: world.now, log: sqliteInboxLog });
  const db = new Database(join(dataDir, "inbox", INBOX_DB_FILE), { readonly: true, strict: true });
  try {
    const threads = store.threadIds();
    expect(threads.length).toBeGreaterThan(10);
    let answered = 0;
    for (const threadId of threads) {
      const ids = store.threadMessageIds(threadId);
      const root = store.message(threadId)!;
      expect(db.query("SELECT message_count, resolved_at, deleted_at FROM threads WHERE id = ?").get(threadId)).toEqual({ message_count: ids.length, resolved_at: root.resolved_at, deleted_at: null });
      for (const id of ids) {
        const row = db.query(`SELECT ${CURRENT("message", "r")}, thread_id, first_seq FROM messages r WHERE id = ?`).get(id) as { record: string; thread_id: string; first_seq: number };
        expect(JSON.parse(row.record)).toEqual(store.message(id));
        expect(row.first_seq).toBe(store.messageCursor(id)!);
        for (const q of store.questionsOf(id)) {
          const record = store.questionRecord(`${id}/${q.key}`)!;
          const qrow = db.query(`SELECT ${CURRENT("question", "r")}, thread_id, current_answer_id FROM questions r WHERE id = ?`).get(record.id) as { record: string; thread_id: string; current_answer_id: string | null };
          expect(JSON.parse(qrow.record)).toEqual(record);
          expect(qrow.thread_id).toBe(threadId);
          const answer = db.query("SELECT id, state, answer FROM answers WHERE question_id = ?").get(record.id) as { id: string; state: string; answer: string | null } | null;
          if (record.answer === null) {
            expect(answer === null || answer.state === "withdrawn").toBe(true);
            continue;
          }
          answered += 1;
          expect(answer!.id).toBe(qrow.current_answer_id!);
          expect(JSON.parse(answer!.answer!)).toEqual(record.answer);
          expect(answer!.state).toBe(record.sent_reply_id !== null && record.sent_revision === record.revision ? "sent" : "picked");
        }
      }
    }
    expect(answered).toBeGreaterThan(3);
    // The world deleted threads: each is a tombstone, with no message, question or change-log row left.
    const gone = db.query("SELECT id FROM threads WHERE deleted_at IS NOT NULL").all() as { id: string }[];
    expect(gone.length).toBeGreaterThan(0);
    for (const { id } of gone) {
      expect(store.message(id)).toBeNull();
      expect(db.query("SELECT count(*) AS n FROM messages WHERE thread_id = ?").get(id)).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM events WHERE thread_id = ?").get(id)).toEqual({ n: 0 });
    }
    // Decision history: per question, the choices and Sends in order read the same from the change log as from
    // every line today's JSONL kept; typing (the world types notes a few keys at a time) left fewer rows.
    const steps = (records: InboxQuestionRecord[]) =>
      records
        .map((q) => JSON.stringify([q.answer?.selected ?? null, q.answer?.skipped ?? false, q.sent_reply_id !== null && q.sent_revision === q.revision, q.superseded_by ?? null, q.set_aside ?? null]))
        .filter((step, i, all) => i === 0 || step !== all[i - 1]);
    const jsonlLines = jsonlInboxLog(join(dataDir, "inbox"))
      .read()
      .lines!.filter((line) => line.kind === "question" && store.questionRecord(line.id) !== null)
      .sort((a, b) => a.seq - b.seq);
    const logged = db.query("SELECT subject_id, data FROM events WHERE kind = 'question' ORDER BY seq").all() as { subject_id: string; data: string }[];
    expect(logged.length).toBeLessThan(jsonlLines.length);
    for (const id of new Set(jsonlLines.map((line) => line.id))) {
      const today = jsonlLines.flatMap((line) => (line.id === id ? [line.record as InboxQuestionRecord] : []));
      const kept = logged.flatMap((row) => (row.subject_id === id ? [JSON.parse(row.data) as InboxQuestionRecord] : []));
      expect(steps(kept)).toEqual(steps(today));
    }
    const floor = db.query("SELECT value FROM meta WHERE key = 'seq_floor'").get() as { value: string };
    expect(Number(floor.value)).toBeGreaterThan(0);
    expect(Number(floor.value)).toBeLessThanOrEqual(store.cursor());
  } finally {
    db.close();
  }
});
