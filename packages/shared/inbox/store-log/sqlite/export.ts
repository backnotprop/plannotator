/// <reference types="bun-types" />
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

/** A folder for lines whose project the database does not know; the reader reads every folder. */
const UNPLACED = "unplaced";

/** Write the database as JSONL files under `outDir`; each line byte for byte as the JSONL log writes it. Deleted threads and projects have no row, so they are not written. */
export function exportInboxDb(dbFile: string, outDir: string): { lines: number } {
  // Read-write, never created: a database in WAL mode with no side files cannot be opened read-only.
  const db = new Database(dbFile, { readwrite: true, create: false, strict: true });
  const files = new Map<string, string[]>();
  let lines = 0;
  try {
    // One read transaction: a running Inbox may write meanwhile, and the export is one moment of it.
    db.run("BEGIN");
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
      // The record's own text, so the bytes match the JSONL log's.
      const text = `{"v":${JSON.stringify(row.v)},"seq":${row.seq},"at":${JSON.stringify(row.at)},"kind":${JSON.stringify(row.kind)},"id":${JSON.stringify(row.subject_id)},"record":${row.data}}`;
      const list = files.get(path);
      if (list) list.push(text);
      else files.set(path, [text]);
      lines++;
    }
    const floor = Number(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'seq_floor'").get()?.value ?? 0);
    db.run("COMMIT");
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
