/**
 * The switch unset (the default): a new install starts on SQLite, every other Inbox stays as it is (`open-store.ts`
 * `chooseInboxLog`).
 *
 * The failures this guards: an existing Inbox moving (or changing one byte) without the switch; a new install
 * starting on the files, or showing a "Backup" in Settings → Storage when nothing moved; a database left behind by
 * the switch going quiet; two Inboxes starting at the same moment failing or ending on different logs.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEQ_FLOOR_FILE } from "../../schema";
import { InboxStore } from "../../store";
import { everyRead } from "../reads";
import { writeInboxWorld } from "../world";
import { openInboxStore } from "./open-store";
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

test("unset, a new install starts on SQLite: nothing moves, no backup, Storage counts the database, and it stays on SQLite", async () => {
  const { dataDir, inbox } = scratch();
  const first = await openInboxStore(dataDir, { sqlite: null, now });
  expect(first).toMatchObject({ log: "sqlite", why: "new_install", moved: { status: "empty" } });
  expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(true);
  // Nothing was moved, so there are no files and no backup.
  expect(existsSync(join(inbox, "projects"))).toBe(false);
  expect(backups(inbox)).toEqual([]);
  sendSome(first.store);
  const usage = first.store.diskUsage();
  expect(usage.backups).toEqual([]);
  expect(usage.database).toBeGreaterThan(0);
  expect(usage.bytes).toBeGreaterThanOrEqual(usage.database!);

  // A Delete makes the total fall, as on the files (not rise with the log the delete writes).
  const scratchThread = first.store.sendMessage({ project_id: first.store.listProjects()[0]!.id, author: AGENT, body: "A short thread, deleted." }).message.thread_id;
  const withIt = first.store.diskUsage().bytes;
  first.store.deleteThread(scratchThread);
  expect(first.store.diskUsage().bytes).toBeLessThan(withIt);
  const served = reads(first.store);

  // The next start remembers it from the database alone.
  const again = await openInboxStore(dataDir, { sqlite: null, now });
  expect(again).toMatchObject({ log: "sqlite", why: "database", moved: { status: "already" } });
  expect(reads(again.store)).toEqual(served);
  expect(backups(inbox)).toEqual([]);
});

test("unset with record files: today's store, not one byte changes; with only settings, drafts and pins: a new install", async () => {
  const withFiles = scratch();
  writeInboxWorld({ dataDir: withFiles.dataDir, seed: 61, steps: 60 });
  const before = tree(withFiles.inbox);
  const files = await openInboxStore(withFiles.dataDir, { sqlite: null, now });
  expect(files).toMatchObject({ log: "jsonl", why: "files" });
  expect(files.moved).toBeUndefined();
  expect(tree(withFiles.inbox)).toEqual(before);

  // Everything an Inbox writes besides records (registry, pins, drafts), and an empty `projects` folder: nothing to move, so it starts on SQLite, the empty folder goes, and no backup appears.
  const bare = scratch();
  mkdirSync(join(bare.inbox, "projects"), { recursive: true });
  mkdirSync(join(bare.inbox, "drafts"), { recursive: true });
  writeFileSync(join(bare.inbox, "pins.json"), "[]\n");
  writeFileSync(join(bare.inbox, "inbox.json"), "{}\n");
  const fresh = await openInboxStore(bare.dataDir, { sqlite: null, now });
  expect(fresh).toMatchObject({ log: "sqlite", why: "new_install", moved: { status: "empty" } });
  expect(existsSync(join(bare.inbox, "projects"))).toBe(false);
  expect(backups(bare.inbox)).toEqual([]);

  // Every project deleted leaves the seq floor: an Inbox that was used stays on its files.
  const emptied = scratch();
  mkdirSync(join(emptied.inbox, "projects"), { recursive: true });
  writeFileSync(join(emptied.inbox, SEQ_FLOOR_FILE), '{"seq":42}\n');
  expect(await openInboxStore(emptied.dataDir, { sqlite: null, now })).toMatchObject({ log: "jsonl", why: "files" });
});

test("the switch wins both ways: off moves a new install back into files, and unset then stays on them", async () => {
  const { dataDir, inbox } = scratch();
  const fresh = await openInboxStore(dataDir, { sqlite: null, now });
  sendSome(fresh.store);
  const served = reads(fresh.store);

  const off = await openInboxStore(dataDir, { sqlite: false, now });
  expect(off).toMatchObject({ log: "jsonl", why: "switch_off", moved: { status: "returned" } });
  expect(reads(off.store)).toEqual(served);
  expect(statSync(join(inbox, "projects")).isDirectory()).toBe(true);
  expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);

  const unset = await openInboxStore(dataDir, { sqlite: null, now });
  expect(unset).toMatchObject({ log: "jsonl", why: "files" });
  expect(reads(unset.store)).toEqual(served);

  // Deleting the Inbox folder makes it new again.
  rmSync(inbox, { recursive: true, force: true });
  expect(await openInboxStore(dataDir, { sqlite: null, now })).toMatchObject({ log: "sqlite", why: "new_install" });
}, 60_000);

test("a database deleted by hand: the next start is a new install", async () => {
  const { dataDir, inbox } = scratch();
  const fresh = await openInboxStore(dataDir, { sqlite: null, now });
  sendSome(fresh.store);
  (fresh.store as unknown as { log: { close(): void } }).log.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(inbox, `${INBOX_DB_FILE}${suffix}`), { force: true });
  const next = await openInboxStore(dataDir, { sqlite: null, now });
  expect(next).toMatchObject({ log: "sqlite", why: "new_install" });
  expect(next.store.listProjects()).toEqual([]);
});

test("two Inboxes starting on the same empty folder at the same moment both end on SQLite, without an error", async () => {
  const child = join(import.meta.dir, "fixtures", "import-child.ts");
  for (let round = 0; round < 10; round++) {
    const { dataDir } = scratch();
    const runs = [0, 1, 2].map(() => Bun.spawn([process.execPath, child, dataDir, now().toISOString(), "open"], { stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(runs.map(async (run) => ({ code: await run.exited, out: await new Response(run.stdout).text(), err: await new Response(run.stderr).text() })));
    // One object, so a failure shows all of what the process said.
    for (const run of outs) expect({ ...run, ok: /^done sqlite (new_install|database) 0\n$/.test(run.out) }).toMatchObject({ code: 0, err: "", ok: true });
  }
}, 60_000);
