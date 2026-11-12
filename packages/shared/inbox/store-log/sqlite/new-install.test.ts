/**
 * A new install and the SQLite switch (`open-store.ts`): with no setting it starts on the files; turned on it starts
 * on SQLite with nothing moved and no backup; turned off again everything goes back into the files.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "../../store";
import { everyRead } from "../reads";
import { writeInboxWorld } from "../world";
import { openInboxStore, resolveInboxSqlite } from "./open-store";
import { INBOX_DB_FILE } from "./sqlite-log";

const AGENT = { kind: "agent" as const, host: "claude-code", session: "ses_new_a", name: "Claude Code" };
const SESSIONS = ["ses_new_a", "ses_world_a", "ses_world_b", "ses_world_c"];
const now = () => new Date("2026-11-11T10:00:00.000Z");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): { dataDir: string; inbox: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-new-install-"));
  roots.push(dataDir);
  return { dataDir, inbox: join(dataDir, "inbox") };
}

const reads = (store: InboxStore) => everyRead(store, { sessions: SESSIONS, bytes: false });
const backups = (inbox: string) => readdirSync(inbox).filter((name) => name.startsWith("backup-"));

/** Every file under `dir` with its bytes. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string, name: string) => {
    if (statSync(path).isDirectory()) for (const child of readdirSync(path)) walk(join(path, child), name ? `${name}/${child}` : child);
    else out[name] = readFileSync(path, "latin1");
  };
  walk(dir, "");
  return out;
}

function sendSome(store: InboxStore): void {
  const project = store.ensureProject({ name: "web", root: "/work/web" });
  store.sendMessage({ project_id: project.id, author: AGENT, body: "First message on a new install." });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: ["Ship it?", "", ":::question", "Ship the change?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n") }).message;
  store.resolveThread(thread.thread_id, true, "person");
}

test("no setting: a new install starts on the files, never on SQLite", async () => {
  const { dataDir, inbox } = scratch();
  const fresh = await openInboxStore(dataDir, { sqlite: resolveInboxSqlite({}, {}), now });
  expect(fresh).toMatchObject({ log: "jsonl" });
  expect(fresh.moved).toBeUndefined();
  sendSome(fresh.store);
  const served = reads(fresh.store);
  expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);
  expect(readdirSync(join(inbox, "projects")).length).toBeGreaterThan(0);

  const again = await openInboxStore(dataDir, { sqlite: resolveInboxSqlite({}, {}), now });
  expect(again).toMatchObject({ log: "jsonl" });
  expect(reads(again.store)).toEqual(served);
  expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);
});

test("the setting on a new install: SQLite, nothing moved, no backup, Storage counts the database, and it stays on SQLite", async () => {
  const { dataDir, inbox } = scratch();
  const first = await openInboxStore(dataDir, { sqlite: resolveInboxSqlite({ inboxSqlite: true }, {}), now });
  expect(first).toMatchObject({ log: "sqlite", moved: { status: "empty" } });
  expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(true);
  expect(existsSync(join(inbox, "projects"))).toBe(false);
  expect(backups(inbox)).toEqual([]);
  sendSome(first.store);
  const usage = first.store.diskUsage();
  expect(usage.backups).toEqual([]);
  expect(usage.database).toBeGreaterThan(0);
  expect(usage.bytes).toBeGreaterThanOrEqual(usage.database!);

  const scratchThread = first.store.sendMessage({ project_id: first.store.listProjects()[0]!.id, author: AGENT, body: "A short thread, deleted." }).message.thread_id;
  const withIt = first.store.diskUsage().bytes;
  first.store.deleteThread(scratchThread);
  expect(first.store.diskUsage().bytes).toBeLessThan(withIt);
  const served = reads(first.store);

  const again = await openInboxStore(dataDir, { sqlite: true, now });
  expect(again).toMatchObject({ log: "sqlite", moved: { status: "already" } });
  expect(reads(again.store)).toEqual(served);
  expect(backups(inbox)).toEqual([]);
});

test("the setting on an Inbox that never got a message (settings, drafts, pins, an empty projects folder): SQLite, and no empty backup", async () => {
  const { dataDir, inbox } = scratch();
  mkdirSync(join(inbox, "projects"), { recursive: true });
  mkdirSync(join(inbox, "drafts"), { recursive: true });
  writeFileSync(join(inbox, "pins.json"), "[]\n");
  writeFileSync(join(inbox, "inbox.json"), "{}\n");
  const on = await openInboxStore(dataDir, { sqlite: true, now });
  expect(on).toMatchObject({ log: "sqlite", moved: { status: "empty" } });
  expect(existsSync(join(inbox, "projects"))).toBe(false);
  expect(backups(inbox)).toEqual([]);
  expect(readFileSync(join(inbox, "pins.json"), "utf8")).toBe("[]\n");
});

test("switched back: the files again with nothing lost, and with no setting it stays on them", async () => {
  const { dataDir, inbox } = scratch();
  const on = await openInboxStore(dataDir, { sqlite: true, now });
  sendSome(on.store);
  const served = reads(on.store);

  const off = await openInboxStore(dataDir, { sqlite: resolveInboxSqlite({ inboxSqlite: false }, {}), now });
  expect(off).toMatchObject({ log: "jsonl", moved: { status: "returned" } });
  expect(reads(off.store)).toEqual(served);
  expect(statSync(join(inbox, "projects")).isDirectory()).toBe(true);
  expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);
  expect(backups(inbox).some((name) => name.endsWith("-sqlite"))).toBe(true);

  const unset = await openInboxStore(dataDir, { sqlite: resolveInboxSqlite({}, {}), now });
  expect(unset).toMatchObject({ log: "jsonl" });
  expect(reads(unset.store)).toEqual(served);
}, 60_000);

test("an existing Inbox with no setting: not one byte changes", async () => {
  const { dataDir, inbox } = scratch();
  writeInboxWorld({ dataDir, seed: 61, steps: 60 });
  const before = tree(inbox);
  const files = await openInboxStore(dataDir, { sqlite: resolveInboxSqlite({}, {}), now });
  expect(files).toMatchObject({ log: "jsonl" });
  expect(files.moved).toBeUndefined();
  expect(tree(inbox)).toEqual(before);
});

test("two Inboxes starting on the same empty folder with the setting on, at the same moment, both end on SQLite without an error", async () => {
  const child = join(import.meta.dir, "fixtures", "import-child.ts");
  for (let round = 0; round < 10; round++) {
    const { dataDir } = scratch();
    const runs = [0, 1, 2].map(() => Bun.spawn([process.execPath, child, dataDir, now().toISOString(), "open"], { stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(runs.map(async (run) => ({ code: await run.exited, out: await new Response(run.stdout).text(), err: await new Response(run.stderr).text() })));
    for (const run of outs) expect({ ...run, ok: /^done sqlite 0\n$/.test(run.out) }).toMatchObject({ code: 0, err: "", ok: true });
  }
}, 60_000);
