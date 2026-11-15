import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "../../store";
import { everyRead } from "../reads";
import { writeInboxWorld } from "../world";
import { INBOX_DB_FILE, InboxReturnError, returnFromSqlite } from "./return";

const FIXTURE = join(import.meta.dir, "fixtures", "v0.28.64");
const NOW = () => new Date("2026-11-13T10:00:00Z");
const SESSIONS = ["ses_world_a", "ses_world_b", "ses_world_c"];

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-sqlite-return-"));
  roots.push(dir);
  return dir;
}

function onSqlite(): string {
  const dataDir = scratch();
  const inbox = join(dataDir, "inbox");
  cpSync(join(FIXTURE, "inbox"), inbox, { recursive: true });
  const db = new Database(join(inbox, INBOX_DB_FILE), { create: true });
  db.run(readFileSync(join(inbox, "inbox.sql"), "utf8"));
  db.run("PRAGMA journal_mode = WAL");
  db.close();
  rmSync(join(inbox, "inbox.sql"));
  return dataDir;
}

function reads(dataDir: string) {
  return everyRead(InboxStore.open(dataDir, { now: NOW }), { sessions: SESSIONS, bytes: false });
}

const expected = (() => {
  let value: ReturnType<typeof reads> | null = null;
  return () => {
    if (value) return value;
    const dataDir = scratch();
    cpSync(join(FIXTURE, "inbox"), join(dataDir, "inbox"), { recursive: true });
    rmSync(join(dataDir, "inbox", "inbox.sql"));
    cpSync(join(FIXTURE, "expected"), join(dataDir, "inbox"), { recursive: true });
    value = reads(dataDir);
    return value;
  };
})();

function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name))
    .map((path) => `${path}:${statSync(path).size}:${statSync(path).mtimeMs}`)
    .sort();
}

describe("an Inbox that ran on SQLite returns to its files", () => {
  test("it serves what v0.28.64's own way back served, keeps the database as a backup, and does it once", () => {
    const dataDir = onSqlite();
    const inbox = join(dataDir, "inbox");
    mkdirSync(join(inbox, "projects", "old"), { recursive: true });
    writeFileSync(join(inbox, "projects", "old", "project.json"), "{}\n");
    mkdirSync(join(inbox, "backup-2026-11-11-jsonl", "projects", "old"), { recursive: true });
    writeFileSync(join(inbox, "inbox.db.importing"), "half");
    expect(returnFromSqlite(dataDir, { now: NOW })?.lines).toBe(109);
    expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);
    expect(existsSync(join(inbox, "inbox.db.importing"))).toBe(false);
    expect(existsSync(join(inbox, "backup-2026-11-13-sqlite", INBOX_DB_FILE))).toBe(true);
    expect(existsSync(join(inbox, "backup-2026-11-13-jsonl", "projects", "old", "project.json"))).toBe(true);
    expect((reads(dataDir).threads as unknown[]).length).toBeGreaterThan(10);
    expect(reads(dataDir)).toEqual(expected());
    const after = tree(inbox);
    expect(returnFromSqlite(dataDir, { now: NOW })).toBeNull();
    expect(tree(inbox)).toEqual(after);
  });

  test.each([
    ["exported", 1],
    ["marked", 1],
    ["entry", 1],
    ["entry", 2],
    ["entry", 3],
    ["placed", 1],
  ])("a kill at %s (%i) leaves an Inbox the next start finishes", (step, nth) => {
    const dataDir = onSqlite();
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", "kill-child.ts"), dataDir, String(step), String(nth)]);
    expect(child.signalCode).toBe("SIGKILL");
    returnFromSqlite(dataDir, { now: NOW });
    expect(existsSync(join(dataDir, "inbox", INBOX_DB_FILE))).toBe(false);
    expect(reads(dataDir)).toEqual(expected());
  });
});

test("a database that will not export stays where it is, with nothing placed, and the start is refused in plain words", () => {
  const dataDir = onSqlite();
  const inbox = join(dataDir, "inbox");
  const db = new Database(join(inbox, INBOX_DB_FILE));
  db.run("UPDATE events SET data = '{' WHERE seq = (SELECT MAX(seq) FROM events WHERE kind = 'message')");
  db.close();
  expect(() => returnFromSqlite(dataDir, { now: NOW })).toThrow(InboxReturnError);
  expect(() => returnFromSqlite(dataDir, { now: NOW })).toThrow(`its messages are in ${join(inbox, INBOX_DB_FILE)}`);
  expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(true);
  expect(readdirSync(inbox).filter((name) => name === "projects" || name === "seq.json" || name.startsWith("jsonl-return"))).toEqual([]);
});

test("an Inbox that never ran on SQLite is left as it is", () => {
  const dataDir = scratch();
  writeInboxWorld({ dataDir, seed: 3, steps: 40 });
  const before = tree(join(dataDir, "inbox"));
  expect(returnFromSqlite(dataDir, { now: NOW })).toBeNull();
  expect(tree(join(dataDir, "inbox"))).toEqual(before);
});
