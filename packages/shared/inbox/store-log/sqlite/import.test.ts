/** Moving an Inbox into `inbox.db` loses nothing and never risks the files; a failed check, failed write or full disk leaves the files serving with no database beside them. */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PROJECTS_DIR, INITIATIVES_FILE, MESSAGES_FILE, SEQ_FLOOR_FILE } from "../../schema";
import { InboxStore } from "../../store";
import { jsonlInboxLog } from "../jsonl-log";
import { everyRead } from "../reads";
import { writeInboxWorld } from "../world";
import { exportInboxDb } from "./export";
import { writeOldShapeInbox } from "./fixtures/old-shapes";
import { importJsonlInbox, INBOX_DB_IMPORTING } from "./import";
import { INBOX_DB_FILE, sqliteInboxLog } from "./sqlite-log";
import { tablesOf } from "./tables-of";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSIONS = ["ses_world_a", "ses_world_b", "ses_world_c"];
const ENTRIES = [INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE];

function filesWorld(seed: number) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-import-"));
  roots.push(dataDir);
  const world = writeInboxWorld({ dataDir, seed, steps: 260 });
  const inbox = join(dataDir, "inbox");
  const project = readdirSync(join(inbox, INBOX_PROJECTS_DIR))[0]!;
  const messages = join(inbox, INBOX_PROJECTS_DIR, project, MESSAGES_FILE);
  const firstLine = readFileSync(messages, "utf8").split("\n")[0]!;
  appendFileSync(messages, `${firstLine}\n{"v":1,"seq":`);
  return { dataDir, inbox, now: world.now };
}

const reads = (dataDir: string, now: () => Date, log = jsonlInboxLog) => everyRead(InboxStore.open(dataDir, { now, log }), { sessions: SESSIONS, bytes: false });

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string, name: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) for (const child of readdirSync(path)) walk(join(path, child), `${name}/${child}`);
    else out[name] = readFileSync(path, "utf8");
  };
  for (const entry of ENTRIES) walk(join(dir, entry), entry);
  return out;
}

describe("moving an Inbox from its files into inbox.db", () => {
  test(
    "every read is the same after the move; the files go to a dated read-only backup; a second start changes nothing",
    async () => {
      const { dataDir, inbox, now } = filesWorld(21);
      const before = reads(dataDir, now);
      const files = snapshot(inbox);

      const outcome = await importJsonlInbox(dataDir, { now });
      expect(outcome.status).toBe("imported");
      const backup = join(inbox, (outcome as { backup: string }).backup);
      expect((outcome as { backup: string }).backup).toBe(`backup-${now().toISOString().slice(0, 10)}-jsonl`);
      expect(reads(dataDir, now, sqliteInboxLog)).toEqual(before);
      for (const entry of ENTRIES) expect(existsSync(join(inbox, entry))).toBe(false);
      expect(snapshot(backup)).toEqual(files);
      expect(statSync(join(backup, SEQ_FLOOR_FILE)).mode & 0o222).toBe(0);

      expect(await importJsonlInbox(dataDir, { now })).toEqual({ status: "already" });
      expect(reads(dataDir, now, sqliteInboxLog)).toEqual(before);
    },
    120_000,
  );

  test(
    "a crash: a half-written database is thrown away and the move runs again; a complete one finishes moving the files",
    async () => {
      const { dataDir, inbox, now } = filesWorld(22);
      const before = reads(dataDir, now);
      writeFileSync(join(inbox, INBOX_DB_IMPORTING), "half a database");
      writeFileSync(join(inbox, `${INBOX_DB_IMPORTING}-wal`), "half a log");
      const outcome = await importJsonlInbox(dataDir, { now });
      expect(outcome.status).toBe("imported");
      expect(existsSync(join(inbox, INBOX_DB_IMPORTING))).toBe(false);
      expect(existsSync(join(inbox, `${INBOX_DB_IMPORTING}-wal`))).toBe(false);
      expect(reads(dataDir, now, sqliteInboxLog)).toEqual(before);

      const backup = join(inbox, (outcome as { backup: string }).backup);
      for (const entry of ENTRIES) renameSync(join(backup, entry), join(inbox, entry));
      expect(await importJsonlInbox(dataDir, { now })).toEqual({ status: "already" });
      for (const entry of ENTRIES) {
        expect(existsSync(join(inbox, entry))).toBe(false);
        expect(existsSync(join(backup, entry))).toBe(true);
      }
      expect(reads(dataDir, now, sqliteInboxLog)).toEqual(before);
    },
    120_000,
  );

  test(
    "a database that reads differently, a failed write or too little disk leaves the files serving, untouched, and no database",
    async () => {
      const { dataDir, inbox, now } = filesWorld(23);
      const before = reads(dataDir, now);
      const files = snapshot(inbox);
      const untouched = () => {
        expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);
        expect(readdirSync(inbox).filter((name) => name.startsWith(INBOX_DB_IMPORTING))).toEqual([]);
        expect(snapshot(inbox)).toEqual(files);
        expect(reads(dataDir, now)).toEqual(before);
      };

      const changed = await importJsonlInbox(dataDir, {
        now,
        afterWrite: (db) =>
          db.run("UPDATE events SET data = json_set(data, '$.body', 'changed') WHERE id = (SELECT max(e.id) FROM events e JOIN messages m ON e.kind = 'message' AND e.subject_id = m.id AND e.seq = m.seq WHERE m.rowid = (SELECT min(rowid) FROM messages))"),
      });
      expect(changed).toMatchObject({ status: "kept_files", reason: "mismatch" });
      expect(readdirSync(inbox).some((name) => name.startsWith("import-check-"))).toBe(true);
      untouched();
      const changedThere = await importJsonlInbox(dataDir, {
        now,
        checkFilesCommand: [process.execPath, join(import.meta.dir, "fixtures", "import-child.ts")],
        afterWrite: (db) => db.run("UPDATE cards SET heard_seq = heard_seq + 1 WHERE rowid = (SELECT min(rowid) FROM cards)"),
      });
      expect(changedThere).toMatchObject({ status: "kept_files", reason: "mismatch" });
      untouched();

      const failed = await importJsonlInbox(dataDir, {
        now,
        afterWrite: () => {
          throw new Error("disk full");
        },
      });
      expect(failed).toEqual({ status: "kept_files", reason: "failed", detail: "disk full" });
      untouched();

      expect(await importJsonlInbox(dataDir, { now, freeBytes: () => 0 })).toMatchObject({ status: "kept_files", reason: "disk" });
      untouched();
    },
    120_000,
  );

  test(
    "disk full while writing: the files keep serving, untouched, with no database; a start with room moves them",
    async () => {
      const { dataDir, inbox, now } = filesWorld(24);
      const before = reads(dataDir, now);
      const files = snapshot(inbox);
      // The database may not grow past a few pages: SQLite's own "database or disk is full".
      const full = await importJsonlInbox(dataDir, { now, beforeLoad: (db) => db.run("PRAGMA max_page_count = 40") });
      expect(full).toMatchObject({ status: "kept_files", reason: "failed" });
      expect((full as { detail: string }).detail).toMatch(/full/i);
      expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);
      expect(readdirSync(inbox).filter((name) => name.startsWith(INBOX_DB_IMPORTING))).toEqual([]);
      expect(snapshot(inbox)).toEqual(files);
      expect(reads(dataDir, now)).toEqual(before);
      expect((await importJsonlInbox(dataDir, { now })).status).toBe("imported");
      expect(reads(dataDir, now, sqliteInboxLog)).toEqual(before);
    },
    120_000,
  );
});

describe("old record shapes, and back out to files", () => {
  test(
    "every old shape the reader accepts moves and reads the same; the export reads the same as files; export then import is the same database",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "plannotator-import-old-"));
      roots.push(dataDir);
      const { now } = writeOldShapeInbox(dataDir);
      const inbox = join(dataDir, "inbox");
      // The fixture holds the shapes it says it does (a change to it cannot drop one unseen).
      const text = Object.values(snapshot(inbox)).join("\n");
      for (const shape of ['"column":"asked"', '"column":"icebox"', '"column":"shipped"', '"decision_on_answer":true', '"steps":[null]', '"merged_into":42', "msg_01NEVERLANDED", '"kind":"decision"', "not json"]) {
        expect(text).toContain(shape);
      }
      const before = reads(dataDir, now);

      expect((await importJsonlInbox(dataDir, { now })).status).toBe("imported");
      expect(reads(dataDir, now, sqliteInboxLog)).toEqual(before);

      const out = mkdtempSync(join(tmpdir(), "plannotator-export-"));
      roots.push(out);
      exportInboxDb(join(inbox, INBOX_DB_FILE), out);
      expect(reads(dataDir, now, () => jsonlInboxLog(out))).toEqual(before);

      // Moved again: every row matches, except when the actor and an answer were first seen, which can move to a later line once typing is gone from the files.
      const again = mkdtempSync(join(tmpdir(), "plannotator-reimport-"));
      roots.push(again);
      cpSync(out, join(again, "inbox"), { recursive: true });
      expect((await importJsonlInbox(again, { now })).status).toBe("imported");
      const omit = { actors: ["created_at"], answers: ["created_at"], meta: ["value"] };
      expect(tablesOf(join(again, "inbox", INBOX_DB_FILE), omit)).toEqual(tablesOf(join(inbox, INBOX_DB_FILE), omit));
    },
    300_000,
  );
});
