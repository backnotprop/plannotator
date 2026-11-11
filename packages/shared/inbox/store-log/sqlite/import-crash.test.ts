/**
 * The move into SQLite (and the way back to the files) killed with SIGKILL at every step boundary and at random
 * points while it writes the database, in a child process (`fixtures/import-child.ts`), on an Inbox holding the old
 * record shapes, a repeated line and a torn last line (`fixtures/old-shapes.ts`). After each kill:
 *
 * - every original record file still exists exactly once, byte for byte, in place or in the dated backup;
 * - no half database serves: an `inbox.db` there is marked complete and passes `integrity_check`;
 * - the next start serves exactly what the Inbox served before, with the switch on (the move finishes) and with it
 *   off (everything is back in the files), and leaves no `inbox.db.importing` behind.
 *
 * The failure this guards: a crash during the upgrade that loses, doubles or hides a message, or leaves the Inbox
 * starting on a half-written database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "../../store";
import { everyRead } from "../reads";
import { seeded, writeInboxWorld } from "../world";
import { writeOldShapeInbox } from "./fixtures/old-shapes";
import { importJsonlInbox } from "./import";
import { INBOX_DB_IMPORTING, jsonlEntriesPresent } from "./move-files";
import { isSqliteMarker } from "./files-marker";
import { openInboxStore } from "./open-store";
import { INBOX_DB_FILE, sqliteInboxLog } from "./sqlite-log";

const CHILD = join(import.meta.dir, "fixtures", "import-child.ts");
const SESSIONS = ["ses_world_a", "ses_world_b", "ses_world_c"];
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `plannotator-crash-${name}-`));
  roots.push(dir);
  return dir;
};

/** Every record file of the Inbox, by its path under its entry, wherever it is (in place or in a JSONL backup). Fails on a file found twice. */
function recordFiles(inbox: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string, name: string) => {
    if (statSync(path).isDirectory()) for (const child of readdirSync(path)) walk(join(path, child), `${name}/${child}`);
    else {
      expect(out[name]).toBeUndefined();
      out[name] = readFileSync(path, "latin1");
    }
  };
  const homes = [inbox, ...readdirSync(inbox).filter((n) => /^backup-.*-jsonl/.test(n)).map((n) => join(inbox, n))];
  // The note an Inbox on SQLite leaves as `projects` is not a record file (`files-marker.ts`).
  for (const home of homes) for (const entry of jsonlEntriesPresent(home)) walk(join(home, entry), entry);
  return out;
}

/** An `inbox.db` is there only complete and whole. */
function noHalfDatabase(inbox: string): void {
  const file = join(inbox, INBOX_DB_FILE);
  if (!existsSync(file)) return;
  const db = new Database(file, { readwrite: true, create: false, strict: true });
  try {
    expect(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'import_complete'").get()?.value).toBeTruthy();
    expect(db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  } finally {
    db.close();
  }
}

const readsOf = (store: InboxStore) => everyRead(store, { sessions: SESSIONS, bytes: false });

/** The next start with the switch `on`: what it serves, and that it left no half file. */
async function restart(dataDir: string, now: () => Date, on: boolean) {
  const opened = await openInboxStore(dataDir, { sqlite: on, now });
  expect(opened.log).toBe(on ? "sqlite" : "jsonl");
  const inbox = join(dataDir, "inbox");
  expect(readdirSync(inbox).filter((n) => n.startsWith(INBOX_DB_IMPORTING))).toEqual([]);
  return readsOf(opened.store);
}

async function runChild(dataDir: string, nowIso: string, mode: string, killAfterLoadingMs?: number): Promise<{ killed: boolean; out: string }> {
  const child = Bun.spawn([process.execPath, CHILD, dataDir, nowIso, mode], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let killed = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
    if (killAfterLoadingMs !== undefined && !killed && out.includes("loading ")) {
      killed = true;
      // The kill lands while the stream is still read: a child that finishes first just ends it.
      void Bun.sleep(killAfterLoadingMs).then(() => child.kill("SIGKILL")); // inbox-guard: own child
    }
  }
  await child.exited;
  if (child.signalCode !== "SIGKILL" && child.exitCode !== 0) throw new Error(`child failed: ${await new Response(child.stderr).text()}`);
  return { killed: child.signalCode === "SIGKILL", out };
}

describe("a crash while moving into SQLite", () => {
  let pristine: string;
  let nowIso: string;
  let now: () => Date;
  let originals: Record<string, string>;
  let before: Record<string, unknown>;

  beforeAll(() => {
    pristine = temp("pristine");
    ({ now } = writeOldShapeInbox(pristine));
    nowIso = now().toISOString();
    originals = recordFiles(join(pristine, "inbox"));
    before = readsOf(InboxStore.open(pristine, { now }));
  }, 120_000);

  /** One crash: a copy of the Inbox, the child killed as `mode` says, then every check, with the switch on and off. */
  async function crash(mode: string, killAfterLoadingMs?: number) {
    const dataDir = temp("run");
    cpSync(pristine, dataDir, { recursive: true });
    const run = await runChild(dataDir, nowIso, mode, killAfterLoadingMs);
    const inbox = join(dataDir, "inbox");
    expect(recordFiles(inbox)).toEqual(originals);
    noHalfDatabase(inbox);
    // The switch turned off right after the crash: the files serve all of it.
    const off = temp("off");
    cpSync(dataDir, off, { recursive: true });
    expect(await restart(off, now, false)).toEqual(before);
    // The next start with the switch on: the move finishes (or runs again), and serves the same.
    expect(await restart(dataDir, now, true)).toEqual(before);
    expect(recordFiles(inbox)).toEqual(originals);
    // No record in place; the note an older Plannotator stops at stands instead.
    expect(jsonlEntriesPresent(inbox)).toEqual([]);
    expect(isSqliteMarker(inbox)).toBe(true);
    noHalfDatabase(inbox);
    return run;
  }

  for (const point of ["read", "rows", "load", "integrity", "checked", "marked", "renamed", "backup-entry:1", "backup-entry:2"]) {
    test(`killed at "${point}"`, async () => {
      const run = await crash(`import:${point}`);
      expect(run.killed).toBe(true);
    }, 120_000);
  }

  test("killed at random points while it works out and writes the database, and while it checks it", async () => {
    // A bigger Inbox, so the bulk write takes long enough to be hit: how long, from "loading" to "loaded" and to the end.
    pristine = temp("big");
    ({ now } = writeInboxWorld({ dataDir: pristine, seed: 12, steps: Number.POSITIVE_INFINITY, messages: 1_000, growOnly: true }));
    nowIso = now().toISOString();
    originals = recordFiles(join(pristine, "inbox"));
    before = readsOf(InboxStore.open(pristine, { now }));
    const sample = temp("sample");
    cpSync(pristine, sample, { recursive: true });
    const whole = await runChild(sample, nowIso, "import");
    const at = (word: string) => Number(new RegExp(`${word} ([0-9.]+)`).exec(whole.out)![1]);
    expect(whole.out).toContain("done imported");
    const span = at("done imported") - at("loading");
    const random = seeded(7);
    let inLoad = 0;
    let killed = 0;
    for (let i = 0; i < 9; i++) {
      // Two in three aimed at the bulk write, the rest anywhere up to the end.
      const end = i % 3 === 2 ? span : at("loaded") - at("loading");
      const run = await crash("import", Math.floor(random() * end));
      if (run.killed) killed++;
      if (run.killed && !run.out.includes("loaded")) inLoad++;
    }
    expect(killed).toBeGreaterThanOrEqual(6);
    expect(inLoad).toBeGreaterThanOrEqual(3);
  }, 600_000);
});

describe("a crash while going back to the files", () => {
  let base: string;
  let nowIso: string;
  let now: () => Date;
  let before: Record<string, unknown>;

  beforeAll(async () => {
    base = temp("sqlite");
    ({ now } = writeOldShapeInbox(base));
    nowIso = now().toISOString();
    expect((await importJsonlInbox(base, { now })).status).toBe("imported");
    // Messages written while the Inbox ran on SQLite: the way back must keep them.
    const log = sqliteInboxLog(join(base, "inbox"));
    try {
      const store = InboxStore.open(base, { now, log: () => log });
      const project = store.listProjects()[0]!;
      for (let i = 0; i < 3; i++) store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses_world_a", name: "Claude Code" }, body: `Written on SQLite ${i}.` });
      before = readsOf(store);
    } finally {
      log.close();
    }
  }, 120_000);

  for (const point of ["exported", "marked", "entry:1", "entry:2", "placed"]) {
    test(`killed at "${point}"`, async () => {
      const dataDir = temp("back");
      cpSync(base, dataDir, { recursive: true });
      expect((await runChild(dataDir, nowIso, `return:${point}`)).killed).toBe(true);
      const on = temp("back-on");
      cpSync(dataDir, on, { recursive: true });
      // Off: it finishes going back, and the files serve everything, the messages written on SQLite included.
      expect(await restart(dataDir, now, false)).toEqual(before);
      expect(existsSync(join(dataDir, "inbox", INBOX_DB_FILE))).toBe(false);
      // On again instead: the same, from SQLite.
      expect(await restart(on, now, true)).toEqual(before);
    }, 120_000);
  }
});
