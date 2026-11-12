/**
 * Moving an Inbox from its JSONL files into `inbox.db` (`import.ts`) loses nothing and never risks the files:
 * every read the server makes is the same after the move, the files end in a dated read-only backup, a crash at
 * any point is finished or undone by the next start, and a database that reads differently (or a write that
 * fails, or too little disk) leaves the files serving, untouched, with no database beside them.
 *
 * The failures this guards: an upgrade that drops or changes a record, a seq, a name, a PR event or a card's
 * unread mark; a crash that leaves two records of the Inbox or none; a failed check that still switches over.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PROJECTS_DIR, INITIATIVES_FILE, MESSAGES_FILE, SEQ_FLOOR_FILE } from "../../schema";
import { InboxStore } from "../../store";
import { jsonlInboxLog } from "../jsonl-log";
import { everyRead } from "../reads";
import { writeInboxWorld } from "../world";
import { importJsonlInbox, INBOX_DB_IMPORTING } from "./import";
import { INBOX_DB_FILE, sqliteInboxLog } from "./sqlite-log";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSIONS = ["ses_world_a", "ses_world_b", "ses_world_c"];
const ENTRIES = [INBOX_PROJECTS_DIR, INITIATIVES_FILE, SEQ_FLOOR_FILE];

/** A generated Inbox on today's files, with a repeated line and a torn last line as a crash leaves them. */
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

/** Every file under the record entries, with its bytes. */
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
    () => {
      const { dataDir, inbox, now } = filesWorld(21);
      const before = reads(dataDir, now);
      const files = snapshot(inbox);

      const outcome = importJsonlInbox(dataDir, { now });
      expect(outcome.status).toBe("imported");
      const backup = join(inbox, (outcome as { backup: string }).backup);
      expect((outcome as { backup: string }).backup).toBe(`backup-${now().toISOString().slice(0, 10)}-jsonl`);
      expect(reads(dataDir, now, sqliteInboxLog)).toEqual(before);
      // The files, byte for byte, now only in the backup, and read-only.
      for (const entry of ENTRIES) expect(existsSync(join(inbox, entry))).toBe(false);
      expect(snapshot(backup)).toEqual(files);
      expect(statSync(join(backup, SEQ_FLOOR_FILE)).mode & 0o222).toBe(0);

      expect(importJsonlInbox(dataDir, { now })).toEqual({ status: "already" });
      expect(reads(dataDir, now, sqliteInboxLog)).toEqual(before);
    },
    120_000,
  );

  test(
    "a crash: a half-written database is thrown away and the move runs again; a complete one finishes moving the files",
    () => {
      const { dataDir, inbox, now } = filesWorld(22);
      const before = reads(dataDir, now);
      // Killed while writing: a half file under the importing name.
      writeFileSync(join(inbox, INBOX_DB_IMPORTING), "half a database");
      writeFileSync(join(inbox, `${INBOX_DB_IMPORTING}-wal`), "half a log");
      const outcome = importJsonlInbox(dataDir, { now });
      expect(outcome.status).toBe("imported");
      expect(existsSync(join(inbox, INBOX_DB_IMPORTING))).toBe(false);
      expect(existsSync(join(inbox, `${INBOX_DB_IMPORTING}-wal`))).toBe(false);
      expect(reads(dataDir, now, sqliteInboxLog)).toEqual(before);

      // Killed after the rename, before the files moved: they are back in place beside a complete database.
      const backup = join(inbox, (outcome as { backup: string }).backup);
      for (const entry of ENTRIES) renameSync(join(backup, entry), join(inbox, entry));
      expect(importJsonlInbox(dataDir, { now })).toEqual({ status: "already" });
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
    () => {
      const { dataDir, inbox, now } = filesWorld(23);
      const before = reads(dataDir, now);
      const files = snapshot(inbox);
      const untouched = () => {
        expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);
        expect(readdirSync(inbox).filter((name) => name.startsWith(INBOX_DB_IMPORTING))).toEqual([]);
        expect(snapshot(inbox)).toEqual(files);
        expect(reads(dataDir, now)).toEqual(before);
      };

      // One message's words changed after the write: the check sees it.
      const changed = importJsonlInbox(dataDir, {
        now,
        afterWrite: (db) => db.run("UPDATE messages SET record = json_set(record, '$.body', 'changed') WHERE rowid = (SELECT min(rowid) FROM messages)"),
      });
      expect(changed).toMatchObject({ status: "kept_files", reason: "mismatch" });
      expect(readdirSync(inbox).some((name) => name.startsWith("import-check-"))).toBe(true);
      untouched();

      const failed = importJsonlInbox(dataDir, {
        now,
        afterWrite: () => {
          throw new Error("disk full");
        },
      });
      expect(failed).toEqual({ status: "kept_files", reason: "failed", detail: "disk full" });
      untouched();

      expect(importJsonlInbox(dataDir, { now, freeBytes: () => 0 })).toMatchObject({ status: "kept_files", reason: "disk" });
      untouched();
    },
    120_000,
  );
});
