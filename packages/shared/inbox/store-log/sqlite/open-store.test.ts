/**
 * The SQLite switch at start (`open-store.ts`). Off with no database: today's store, and nothing on disk changes.
 * On: the files move and the database serves; Settings → Storage counts the database and lists the backup, whose
 * Remove takes it for good. Off again: everything, messages written on SQLite included, goes back into the files,
 * and a way back that would read differently never happens (the database keeps serving).
 *
 * The failures this guards: the switch off touching anyone's files; turning it off losing or hiding the messages
 * written while it was on; a removed backup coming back; Storage not counting the database.
 */
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PROJECTS_DIR, MESSAGES_FILE } from "../../schema";
import { InboxStore } from "../../store";
import { everyRead } from "../reads";
import { writeInboxWorld } from "../world";
import { JSONL_ENTRIES, jsonlEntriesPresent } from "./move-files";
import { openInboxStore, resolveInboxSqlite } from "./open-store";
import { INBOX_RETURN_PARTIAL, returnToJsonl } from "./return-to-files";
import { INBOX_DB_FILE } from "./sqlite-log";

const SESSIONS = ["ses_world_a", "ses_world_b", "ses_world_c"];
const AGENT = { kind: "agent" as const, host: "claude-code", session: "ses_world_a", name: "Claude Code" };
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(seed: number) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-open-store-"));
  roots.push(dataDir);
  const { now } = writeInboxWorld({ dataDir, seed, steps: 200 });
  return { dataDir, inbox: join(dataDir, "inbox"), now };
}

const reads = (store: InboxStore) => everyRead(store, { sessions: SESSIONS, bytes: false });

/** Every file under the inbox folder with its bytes (a scratch check folder aside). */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string, name: string) => {
    if (statSync(path).isDirectory()) for (const child of readdirSync(path)) walk(join(path, child), name ? `${name}/${child}` : child);
    else out[name] = readFileSync(path, "latin1");
  };
  walk(dir, "");
  return out;
}

test("the switch reads PLANNOTATOR_INBOX_SQLITE first, then config's inboxSqlite; unset by default", () => {
  expect(resolveInboxSqlite({}, {})).toBeNull();
  expect(resolveInboxSqlite({ inboxSqlite: true }, {})).toBe(true);
  expect(resolveInboxSqlite({ inboxSqlite: false }, {})).toBe(false);
  expect(resolveInboxSqlite({ inboxSqlite: true }, { PLANNOTATOR_INBOX_SQLITE: "0" })).toBe(false);
  expect(resolveInboxSqlite({ inboxSqlite: false }, { PLANNOTATOR_INBOX_SQLITE: "on" })).toBe(true);
  expect(resolveInboxSqlite({ inboxSqlite: "yes" }, { PLANNOTATOR_INBOX_SQLITE: "maybe" })).toBeNull();
});

test("off, with no database: today's store, and not one byte on disk changes", async () => {
  const { dataDir, inbox, now } = world(51);
  const before = tree(inbox);
  const expected = reads(InboxStore.open(dataDir, { now }));
  const opened = await openInboxStore(dataDir, { sqlite: false, now });
  expect(opened).toMatchObject({ log: "jsonl" });
  expect(opened.moved).toBeUndefined();
  expect(reads(opened.store)).toEqual(expected);
  expect(tree(inbox)).toEqual(before);
});

test(
  "on, then off, then on: nothing written on SQLite is lost either way; Storage counts the database and Remove takes a backup for good",
  async () => {
    const { dataDir, inbox, now } = world(52);
    const files = reads(InboxStore.open(dataDir, { now }));

    // On: the files move, the database serves the same.
    const on = await openInboxStore(dataDir, { sqlite: true, now });
    expect(on.log).toBe("sqlite");
    expect(on.moved).toMatchObject({ status: "imported" });
    expect(reads(on.store)).toEqual(files);
    // Storage: the database file counts, once, and the backup with it.
    const usage = on.store.diskUsage();
    expect(usage.database).toBe(statSync(join(inbox, INBOX_DB_FILE)).size + (existsSync(join(inbox, `${INBOX_DB_FILE}-wal`)) ? statSync(join(inbox, `${INBOX_DB_FILE}-wal`)).size : 0) + (existsSync(join(inbox, `${INBOX_DB_FILE}-shm`)) ? statSync(join(inbox, `${INBOX_DB_FILE}-shm`)).size : 0));
    expect(usage.backups).toHaveLength(1);
    expect(usage.backups![0]).toMatchObject({ kind: "jsonl", date: now().toISOString().slice(0, 10) });
    expect(usage.backups![0]!.bytes).toBeGreaterThan(0);
    expect(usage.bytes).toBeGreaterThanOrEqual(usage.database! + usage.backups![0]!.bytes);

    // Messages written while it runs on SQLite.
    const project = on.store.listProjects()[0]!;
    on.store.sendMessage({ project_id: project.id, author: AGENT, body: "Written on SQLite." });
    const thread = on.store.sendMessage({ project_id: project.id, author: AGENT, body: "Another, on SQLite." }).message;
    on.store.resolveThread(thread.thread_id, true, "person");
    const onSqlite = reads(on.store);

    // Remove takes the backup; a later start does not make it again.
    expect(on.store.removeBackup(usage.backups![0]!.name)).toBe(true);
    expect(on.store.removeBackup(usage.backups![0]!.name)).toBe(false);
    expect(on.store.removeBackup("../inbox.db")).toBe(false);
    expect(on.store.diskUsage().backups).toEqual([]);

    // Off: everything goes back into the files, the messages written on SQLite included.
    const off = await openInboxStore(dataDir, { sqlite: false, now });
    expect(off.log).toBe("jsonl");
    expect(off.moved).toMatchObject({ status: "returned" });
    expect(reads(off.store)).toEqual(onSqlite);
    expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);
    expect(existsSync(join(inbox, INBOX_RETURN_PARTIAL))).toBe(false);
    for (const entry of JSONL_ENTRIES.slice(0, 1)) expect(existsSync(join(inbox, entry))).toBe(true);
    const sqliteBackup = readdirSync(inbox).find((name) => /^backup-.*-sqlite$/.test(name))!;
    expect(existsSync(join(inbox, sqliteBackup, INBOX_DB_FILE))).toBe(true);
    // Written on the files now, as today.
    off.store.sendMessage({ project_id: project.id, author: AGENT, body: "Written on the files again." });
    const onFiles = reads(off.store);

    // On again: a second move, the same reads, and a backup of its own.
    const again = await openInboxStore(dataDir, { sqlite: true, now });
    expect(again.moved).toMatchObject({ status: "imported" });
    expect(reads(again.store)).toEqual(onFiles);
    expect(again.store.diskUsage().backups!.map((b) => b.kind).sort()).toEqual(["jsonl", "sqlite"]);
  },
  300_000,
);

test("a way back whose files would read differently never happens: the database keeps serving", async () => {
  const { dataDir, inbox, now } = world(53);
  const on = await openInboxStore(dataDir, { sqlite: true, now });
  const served = reads(on.store);
  const back = returnToJsonl(dataDir, {
    now,
    step: (name) => {
      // The export differs from the database (a line it never held): the check must catch it.
      if (name !== "exported") return;
      const folder = readdirSync(join(inbox, INBOX_RETURN_PARTIAL, INBOX_PROJECTS_DIR))[0]!;
      const file = join(inbox, INBOX_RETURN_PARTIAL, INBOX_PROJECTS_DIR, folder, MESSAGES_FILE);
      const last = readFileSync(file, "utf8").trim().split("\n").at(-1)!;
      const line = JSON.parse(last);
      appendFileSync(file, `${JSON.stringify({ ...line, seq: line.seq + 100_000, record: { ...line.record, body: "Not in the database." } })}\n`);
    },
  });
  expect(back).toMatchObject({ status: "kept_db", reason: "mismatch" });
  expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(true);
  expect(existsSync(join(inbox, INBOX_RETURN_PARTIAL))).toBe(false);
  expect(jsonlEntriesPresent(inbox)).toEqual([]);
  // Nothing was lost meanwhile: the database still serves the same, and a later way back goes through.
  const off = await openInboxStore(dataDir, { sqlite: false, now });
  expect(off.moved).toMatchObject({ status: "returned" });
  expect(reads(off.store)).toEqual(served);
});
