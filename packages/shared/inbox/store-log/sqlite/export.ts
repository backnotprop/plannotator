/// <reference types="bun-types" />
/**
 * The Inbox database written back as today's JSONL files (design brief "The Inbox on SQLite", section 5: export,
 * no lock-in): every `events` row as the line it was written from, in seq order, into the file today's JSONL log
 * keeps that kind in (`../jsonl-log.ts`), under the project's folder; initiatives in `initiatives.jsonl`; the seq
 * floor in `seq.json`. What the JSONL store reads back from them is what the database serves: `return-to-files.ts`
 * and the tests check that with the import's own check (`digest.ts`), the other way round.
 *
 * A line comes out byte for byte as the JSONL log writes one (`JSON.stringify` of `{ v, seq, at, kind, id, record }`,
 * the record as it was written). A line the database keeps no row for is not written: deleted threads and projects,
 * and the typing a question's history wrote over (the store only ever read the last of those).
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxLine } from "@plannotator/core/inbox-types";
import { ANNOTATIONS_FILE, CARDS_FILE, INBOX_PROJECTS_DIR, INITIATIVES_FILE, MESSAGES_FILE, PROJECT_FILE, PULLS_FILE, QUESTIONS_FILE, SEQ_FLOOR_FILE, STEPS_FILE } from "../../schema";

const FILE_OF: Record<InboxLine["kind"], string> = {
  project: PROJECT_FILE,
  message: MESSAGES_FILE,
  question: QUESTIONS_FILE,
  annotation: ANNOTATIONS_FILE,
  card: CARDS_FILE,
  steps: STEPS_FILE,
  thread_pull: PULLS_FILE,
  initiative: INITIATIVES_FILE,
};

/** A folder for lines whose project the database does not know (an old, broken record): the reader reads every folder. */
const UNPLACED = "unplaced";

/** Write the database `dbFile` as JSONL files under `outDir` (`projects/`, `initiatives.jsonl`, `seq.json`). Returns the lines written. */
export function exportInboxDb(dbFile: string, outDir: string): { lines: number } {
  // Read-write, never created: a database in WAL mode with no side files cannot be opened read-only. Nothing is written.
  const db = new Database(dbFile, { readwrite: true, create: false, strict: true });
  const files = new Map<string, string[]>();
  let lines = 0;
  try {
    const keyOf = new Map(db.query<{ id: string; key: string }, []>("SELECT id, key FROM projects WHERE deleted_at IS NULL ORDER BY first_seq").all().map((p) => [p.id, p.key]));
    const fallback = keyOf.values().next().value ?? UNPLACED;
    const rows = db.query<{ seq: number; at: string; v: number; kind: InboxLine["kind"]; subject_id: string; project_id: string | null; data: string }, []>(
      "SELECT seq, at, v, kind, subject_id, project_id, data FROM events ORDER BY seq, id",
    );
    for (const row of rows.iterate()) {
      const path =
        row.kind === "initiative"
          ? INITIATIVES_FILE
          : join(INBOX_PROJECTS_DIR, (row.project_id !== null ? keyOf.get(row.project_id) : undefined) ?? fallback, FILE_OF[row.kind]);
      // `JSON.stringify(line)` as the JSONL log writes it, with the record's own text: no parse and write again.
      const text = `{"v":${JSON.stringify(row.v)},"seq":${row.seq},"at":${JSON.stringify(row.at)},"kind":${JSON.stringify(row.kind)},"id":${JSON.stringify(row.subject_id)},"record":${row.data}}`;
      const list = files.get(path);
      if (list) list.push(text);
      else files.set(path, [text]);
      lines++;
    }
    const floor = Number(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'seq_floor'").get()?.value ?? 0);
    mkdirSync(join(outDir, INBOX_PROJECTS_DIR), { recursive: true, mode: 0o700 });
    for (const key of keyOf.values()) mkdirSync(join(outDir, INBOX_PROJECTS_DIR, key), { recursive: true, mode: 0o700 });
    for (const [path, text] of files) {
      mkdirSync(join(outDir, path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(join(outDir, path), `${text.join("\n")}\n`, { mode: 0o600 });
    }
    if (Number.isSafeInteger(floor) && floor > 0) writeFileSync(join(outDir, SEQ_FLOOR_FILE), `${JSON.stringify({ seq: floor })}\n`, { mode: 0o600 });
    return { lines };
  } finally {
    db.close();
  }
}
