/**
 * Whether the person has turned the Plannotator Inbox on on this computer: the
 * one function every gate reads (`isInboxOn`), and the only writers of the
 * record (`turnInboxOn`, `recordInboxOff`). The rule and the record's shape are
 * in inbox-on-contract.ts.
 *
 * An install from before the rule has no record. `isInboxOn` decides it once,
 * from what the person did with the Inbox (`inboxUseOnDisk`), and writes the
 * record:
 *  - the person used the window (`used`) or ran `plannotator inbox` (`ran`): on;
 *  - only agents ever started it: off, with `notes: 'remove'` (Plannotator's
 *    own untouched notes in agents' instruction files go; the CLI removes
 *    them, `settleInboxOn` in packages/server/inbox-on-settle.ts);
 *  - it never ran here: off.
 * The store's files too slow to read in time: on (`update-slow`, in doubt, on).
 *
 * A lost or corrupt state.json, where a record existed: the record comes back
 * from the decided mark, which keeps a copy of the last one written (so an off
 * stays off and an on stays on); with no copy there, the store is read again
 * and a person who used the Inbox keeps it on (`record-lost`).
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { updateMachineState } from "../config";
import { getPlannotatorDataDir } from "../data-dir";
import {
  INBOX_ON_DECIDED_FILE,
  INBOX_ON_FILE,
  INBOX_ON_KEY,
  inboxOnRecord,
  inboxUseFromFiles,
  type InboxOnBy,
  type InboxOnRecord,
  type InboxUseEvidence,
} from "./inbox-on-contract";

export * from "./inbox-on-contract";

/**
 * For test suites only, never a switch: a scratch data dir (inside the OS temp
 * folder or /tmp) with no record counts as on only when an environment
 * variable that only tests set says so: `PLANNOTATOR_TEST_INBOX_ON=1` (the
 * browser specs and tests that give a child its own env), or the test sandbox
 * marker `PLANNOTATOR_TEST_SANDBOX` (set by the test preload and the
 * import-time sandbox, never outside a test run). So the suites that start an
 * Inbox in a fresh scratch data dir keep doing so, while a test that turns the
 * Inbox off (a record) or sets `PLANNOTATOR_TEST_INBOX_ON=0` sees the real
 * rule. Nothing else counts: a real machine whose HOME or data dir is under
 * /tmp (a container, a CI image, a sandbox) follows the real rule.
 */
export const INBOX_TEST_ON_ENV = "PLANNOTATOR_TEST_INBOX_ON";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether `dir` is inside the OS temp folder or /tmp (a scratch folder, never a person's real data dir). */
export function isScratchFolder(dir: string): boolean {
  const real = realOr(dir);
  return [tmpdir(), "/tmp", "/private/tmp"].some((root) => {
    const base = realOr(root).replace(/[\\/]+$/, "");
    return real.startsWith(`${base}${sep}`) || real.startsWith(`${base}/`);
  });
}

/** Whether a scratch data dir with no record counts as on for a test run (see INBOX_TEST_ON_ENV). */
function testRunCountsOn(dataDir: string, env: Readonly<Record<string, string | undefined>>): boolean {
  const knob = env[INBOX_TEST_ON_ENV]?.trim();
  if (knob === "0") return false;
  if (knob !== "1" && !env.PLANNOTATOR_TEST_SANDBOX?.trim()) return false;
  return isScratchFolder(dataDir);
}

/** The record in this data dir's state.json, or null (not decided yet). */
export function readInboxOnRecord(dataDir: string = getPlannotatorDataDir()): InboxOnRecord | null {
  return inboxOnRecord(readText(join(dataDir, INBOX_ON_FILE)));
}

/**
 * Whether the person has turned the Inbox on here. Every gate calls this: the
 * agents' tool on each host, the reminder, the notes, the MCP server's tools
 * and every start of the Inbox. Undecided (an install from before the rule):
 * decided now, once, and written (see the file header).
 */
export function isInboxOn(dataDir: string = getPlannotatorDataDir(), env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const record = readInboxOnRecord(dataDir);
  if (record) return record.on;
  if (testRunCountsOn(dataDir, env)) return true;
  return decideExistingInstall(dataDir).on;
}

/** Decisions this process made whose write did not land (state.json unwritable): never scanned twice. */
const decidedHere = new Map<string, InboxOnRecord>();

/**
 * The one-time decision for an install from before the rule, written to
 * state.json. Returns the record (the one already there when there is one,
 * also when another process wrote it while this one scanned: the write is a
 * compare-and-set under config.json's lock, so a person's on or off made
 * meanwhile is never overwritten).
 *
 * A computer where no Inbox ever ran (no `inbox/` folder) is off and nothing
 * is written: only the person's act writes the first record there. Where a
 * record existed once (INBOX_ON_DECIDED_FILE) and is gone, the copy in the
 * mark comes back as it was; a mark with no readable copy reads the store
 * again: the person's use keeps it on, else off (`record-lost` either way,
 * and no notes are removed).
 */
export function decideExistingInstall(dataDir: string = getPlannotatorDataDir(), now: Date = new Date()): InboxOnRecord {
  const known = readInboxOnRecord(dataDir);
  if (known) return known;
  const key = realOr(dataDir);
  const earlier = decidedHere.get(key);
  if (earlier) return earlier;
  const at = now.toISOString();
  let record: InboxOnRecord;
  const mark = join(dataDir, INBOX_ON_DECIDED_FILE);
  if (existsSync(mark)) record = recordInMark(mark) ?? { on: inboxUseOnDisk(dataDir) !== null, at, by: "record-lost" };
  else if (!existsSync(join(dataDir, "inbox"))) return { on: false, at, by: "update-never-ran" };
  else {
    const use = inboxUseOnDisk(dataDir);
    const by: InboxOnBy = use === "used" ? "update-used" : use === "slow" ? "update-slow" : use === "ran" ? "update-ran" : "update-agent-only";
    record = { on: use !== null, at, by, ...(by === "update-agent-only" ? { notes: "remove" as const } : {}) };
  }
  const stored = writeInboxOnRecord(dataDir, record, { ifAbsent: true });
  const result = stored.record ?? record;
  if (!stored.ok) decidedHere.set(key, result);
  return result;
}

/** The copy of the last record the decided mark keeps, or null (a mark from before it kept one, or unreadable). */
function recordInMark(mark: string): InboxOnRecord | null {
  const text = readText(mark);
  if (!text) return null;
  try {
    return inboxOnRecord(JSON.stringify({ [INBOX_ON_KEY]: JSON.parse(text) }));
  } catch {
    return null;
  }
}

/** A run of `plannotator inbox` turned the Inbox on (`/plannotator-inbox` runs it). */
export function turnInboxOn(by: InboxOnBy, dataDir: string = getPlannotatorDataDir(), now: Date = new Date()): boolean {
  const known = readInboxOnRecord(dataDir);
  if (known?.on === true && !known.notes) return true;
  return writeInboxOnRecord(dataDir, { on: true, at: now.toISOString(), by }).ok;
}

/** Turn the Inbox off: the record says off (the caller stops the Inbox and removes the notes). */
export function recordInboxOff(dataDir: string = getPlannotatorDataDir(), now: Date = new Date(), notes?: "remove"): boolean {
  return writeInboxOnRecord(dataDir, { on: false, at: now.toISOString(), by: "off", ...(notes ? { notes } : {}) }).ok;
}

/**
 * Write the record: state.json only, under config.json's lock, and never
 * needing config.json (a hand-broken config.json does not block it). With
 * `ifAbsent`, only when there is still no record (the one-time decision);
 * with `ifCurrent`, only while the record is still that one (a follow-up
 * write never undoes an on or off made meanwhile). `ok`: the write landed or
 * was not needed; `record`: what state.json holds now. Also
 * writes the decided mark (INBOX_ON_DECIDED_FILE) with a copy of that record,
 * for a lost state.json. Only this file's functions and inbox-on-settle.ts
 * call it.
 */
export function writeInboxOnRecord(dataDir: string, record: InboxOnRecord, options: { ifAbsent?: boolean; ifCurrent?: InboxOnRecord } = {}): { ok: boolean; record: InboxOnRecord | null } {
  // state.json is the data dir this process resolves; every caller passes that same folder.
  if (realOr(dataDir) !== realOr(getPlannotatorDataDir())) return { ok: false, record: null };
  const read = (value: unknown) => inboxOnRecord(JSON.stringify({ [INBOX_ON_KEY]: value }));
  const same = (x: InboxOnRecord | null, y: InboxOnRecord) => !!x && x.on === y.on && x.at === y.at && x.by === y.by;
  const written = updateMachineState(INBOX_ON_KEY, (current) => {
    if (options.ifAbsent && read(current)) return undefined;
    if (options.ifCurrent && !same(read(current), options.ifCurrent)) return undefined;
    return record;
  });
  const now = read(written.value);
  if (written.ok && now) {
    const mark = join(dataDir, INBOX_ON_DECIDED_FILE);
    const temp = `${mark}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(now)}\n`, { mode: 0o600 });
      renameSync(temp, mark);
    } catch {
      // The mark only brings a lost record back; an old copy, or none, reads the store again.
    }
  }
  return { ok: written.ok, record: now };
}

/**
 * What an install from before the rule shows of the person's own use of the
 * Inbox: the cheap files (inboxUseFromFiles), then the store itself. null:
 * nothing the person did (only agents started it, or it never ran).
 */
export function inboxUseOnDisk(dataDir: string, budgetMs: number = INBOX_SCAN_BUDGET_MS): InboxUseEvidence | "slow" | null {
  const files = inboxUseFromFiles({
    config: readText(join(dataDir, "config.json")),
    state: readText(join(dataDir, INBOX_ON_FILE)),
    agentsFile: existsSync(join(dataDir, "inbox", "agents.json")),
  });
  if (files === "used") return "used";
  const store = storeShowsPersonUse(join(dataDir, "inbox"), Date.now() + budgetMs);
  if (store === "used") return "used";
  // A slow store is kept on, but said as such: `ran` is still the truer reason when there is one.
  if (store === "slow") return files ?? "slow";
  return files;
}

/** What the store shows: the person's use, too slow to read by the deadline (counts as used), or nothing. */
export type StoreUse = "used" | "slow" | null;

/** Not there at all: the one read failure that means "nothing", not "could not read". */
function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Whether the Inbox's store holds something only a person in the window (or a
 * paired phone) leaves: a look at a thread (`person_seen_seq`, a Mark read's
 * `person_read_seq`; only the window's `/seen` and `/read` routes write them),
 * a message the person wrote (not one of the Inbox's own notes or action
 * reports, not a routine's line), an answered question (`picked_at`), a pin,
 * a draft, a paired device, a linked machine or the relay, a snooze, a
 * search. A store not yet returned from SQLite (`inbox.db`) counts as used, so
 * no user of it is cut off. Stops at the first hit. A file or folder that is
 * there but cannot be read (permissions, an I/O error, unparseable JSON)
 * counts as used: in doubt, on. A store too large to read by `deadline` is
 * `slow` (kept on, said as such), so the decision is bounded in time.
 */
export function storeShowsPersonUse(inboxDir: string, deadline: number = Date.now() + INBOX_SCAN_BUDGET_MS): StoreUse {
  if (existsSync(join(inboxDir, "inbox.db"))) return "used";
  if (nonEmptyFile(join(inboxDir, "devices.jsonl"))) return "used";
  for (const name of ["pins.json", "machines.json", "relay.json", "snoozes.json", "recent-searches.json"]) {
    if (nonEmptyJson(join(inboxDir, name))) return "used";
  }
  for (const folder of ["drafts", "reply-drafts"]) {
    try {
      if (readdirSync(join(inboxDir, folder)).some((name) => name.endsWith(".json"))) return "used";
    } catch (error) {
      if (!missing(error)) return "used";
    }
  }
  let projects: string[];
  try {
    projects = readdirSync(join(inboxDir, "projects"));
  } catch (error) {
    return missing(error) ? null : "used";
  }
  for (const project of projects) {
    if (Date.now() > deadline) return "slow";
    for (const [file, test] of [["messages.jsonl", personMessageLine], ["questions.jsonl", pickedQuestionLine]] as const) {
      const found = linesMatch(join(inboxDir, "projects", project, file), test, deadline);
      if (found) return found;
    }
  }
  return null;
}

/** How long the one-time decision may read the store (the Claude Code mod waits on it once). */
export const INBOX_SCAN_BUDGET_MS = 5_000;

function nonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch (error) {
    return !missing(error);
  }
}

/** A JSON file with something in it; one that is there but unreadable or unparseable counts too. */
function nonEmptyJson(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return !missing(error);
  }
  if (!text.trim()) return false;
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) return value.length > 0;
    return !!value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0;
  } catch {
    return true;
  }
}

/** One store line's record (`{ v, seq, at, kind, id, record }`), or null. */
function lineRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as { record?: unknown };
    const record = parsed?.record;
    return record && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function personMessageLine(line: string): boolean {
  if (!line.includes('"person_seen_seq"') && !line.includes('"person_read_seq"') && !line.includes('"person"')) return false;
  const record = lineRecord(line);
  if (!record) return false;
  if (typeof record.person_seen_seq === "number" && record.person_seen_seq > 0) return true;
  if (typeof record.person_read_seq === "number") return true;
  return personWroteIt(record);
}

/**
 * A message the person wrote: authored by the person, and not one of the
 * Inbox's own notes stored as theirs (`isInboxNote` in
 * packages/core/inbox-types.ts: a set-aside, reopened, 👍 or Tidy note, a
 * routine's line) nor an action report (`isInboxActionReport`). Written out
 * here because the Pi extension vendors this file without @plannotator/core;
 * inbox-on.test.ts keeps it equal to those two.
 */
export function personWroteIt(record: Record<string, unknown>): boolean {
  const author = record.author as { kind?: unknown } | null | undefined;
  if (!author || author.kind !== "person") return false;
  const list = (value: unknown) => Array.isArray(value) && value.length > 0;
  if (record.scheduled_run || list(record.set_aside) || list(record.reopened) || list(record.action_report)) return false;
  if (typeof record.ack_of === "string" && record.ack_of !== "") return false;
  if (typeof record.tidy === "object" && record.tidy !== null) return false;
  return true;
}

function pickedQuestionLine(line: string): boolean {
  if (!line.includes('"picked_at"')) return false;
  const record = lineRecord(line);
  return typeof record?.picked_at === "string" && record.picked_at !== "";
}

/** Whether any line of a JSONL file passes `test`, read in chunks so a large store stops at the first hit; past `deadline`, true. */
/** "used" at the first matching line or a read error, "slow" past the deadline, null when no line matches. */
function linesMatch(path: string, test: (line: string) => boolean, deadline: number): StoreUse {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return missing(error) ? null : "used";
  }
  try {
    const chunk = Buffer.alloc(1 << 20);
    const decoder = new StringDecoder("utf8");
    let rest = "";
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      if (Date.now() > deadline) return "slow";
      const text = rest + decoder.write(chunk.subarray(0, read));
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      if (lines.some((line) => line && test(line))) return "used";
    }
    rest += decoder.end();
    return rest !== "" && test(rest) ? "used" : null;
  } catch {
    return "used";
  } finally {
    closeSync(fd);
  }
}
