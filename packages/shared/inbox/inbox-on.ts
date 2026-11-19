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
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
 * folder or /tmp) with no record counts as on under the test sandbox
 * (`PLANNOTATOR_TEST_SANDBOX`, which every test sandbox and child of one
 * carries), with `PLANNOTATOR_TEST_INBOX_ON=1`, or when HOME is a scratch
 * folder too (the browser specs give the binary their own env, always with a
 * scratch HOME). So the suites that start an Inbox in a fresh scratch data dir
 * keep doing so, while a test that turns the Inbox off (a record) or sets
 * `PLANNOTATOR_TEST_INBOX_ON=0` sees the real rule. A person's real data dir
 * and home are never scratch folders, so none of this can turn their Inbox
 * on, write their agents' notes or connect their agents.
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
  const home = env.HOME?.trim();
  if (knob !== "1" && !env.PLANNOTATOR_TEST_SANDBOX && !(home && isScratchFolder(home))) return false;
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
 * record existed once (INBOX_ON_DECIDED_FILE) and is gone, it is off
 * (`record-lost`), never decided again from the evidence.
 */
export function decideExistingInstall(dataDir: string = getPlannotatorDataDir(), now: Date = new Date()): InboxOnRecord {
  const known = readInboxOnRecord(dataDir);
  if (known) return known;
  const key = realOr(dataDir);
  const earlier = decidedHere.get(key);
  if (earlier) return earlier;
  const at = now.toISOString();
  let record: InboxOnRecord;
  if (existsSync(join(dataDir, INBOX_ON_DECIDED_FILE))) record = { on: false, at, by: "record-lost" };
  else if (!existsSync(join(dataDir, "inbox"))) return { on: false, at, by: "update-never-ran" };
  else {
    const use = inboxUseOnDisk(dataDir);
    const by: InboxOnBy = use === "used" ? "update-used" : use === "ran" ? "update-ran" : "update-agent-only";
    record = { on: use !== null, at, by, ...(by === "update-agent-only" ? { notes: "remove" as const } : {}) };
  }
  const stored = writeInboxOnRecord(dataDir, record, { ifAbsent: true });
  const result = stored.record ?? record;
  if (!stored.ok) decidedHere.set(key, result);
  return result;
}

/** The person turned the Inbox on (their own `plannotator inbox`, `/plannotator-inbox`, `plannotator inbox on`). */
export function turnInboxOn(by: InboxOnBy, dataDir: string = getPlannotatorDataDir(), now: Date = new Date()): boolean {
  const known = readInboxOnRecord(dataDir);
  if (known?.on === true && !known.notes) return true;
  return writeInboxOnRecord(dataDir, { on: true, at: now.toISOString(), by }).ok;
}

/** Turn the Inbox off: the record says off (the caller stops the Inbox and removes the notes). */
export function recordInboxOff(dataDir: string = getPlannotatorDataDir(), now: Date = new Date(), notes?: "remove" | "left"): boolean {
  return writeInboxOnRecord(dataDir, { on: false, at: now.toISOString(), by: "off", ...(notes ? { notes } : {}) }).ok;
}

/**
 * Write the record: state.json only, under config.json's lock, and never
 * needing config.json (a hand-broken config.json does not block it). With
 * `ifAbsent`, only when there is still no record (the one-time decision);
 * with `ifCurrent`, only while the record is still that one (a follow-up
 * write never undoes an on or off made meanwhile). `ok`: the write landed or
 * was not needed; `record`: what state.json holds now. Also
 * leaves the decided mark (INBOX_ON_DECIDED_FILE). Only this file's functions
 * and inbox-on-settle.ts call it.
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
    try {
      if (!existsSync(join(dataDir, INBOX_ON_DECIDED_FILE))) writeFileSync(join(dataDir, INBOX_ON_DECIDED_FILE), `${now.at}\n`, { mode: 0o600 });
    } catch {
      // The mark only keeps a lost record from being decided again.
    }
  }
  return { ok: written.ok, record: now };
}

/**
 * What an install from before the rule shows of the person's own use of the
 * Inbox: the cheap files (inboxUseFromFiles), then the store itself. null:
 * nothing the person did (only agents started it, or it never ran).
 */
export function inboxUseOnDisk(dataDir: string, budgetMs: number = INBOX_SCAN_BUDGET_MS): InboxUseEvidence | null {
  const files = inboxUseFromFiles({
    config: readText(join(dataDir, "config.json")),
    state: readText(join(dataDir, INBOX_ON_FILE)),
    agentsFile: existsSync(join(dataDir, "inbox", "agents.json")),
  });
  if (files === "used") return "used";
  if (storeShowsPersonUse(join(dataDir, "inbox"), Date.now() + budgetMs)) return "used";
  return files;
}

/**
 * Whether the Inbox's store holds something only a person in the window (or a
 * paired phone) leaves: a look at a thread (`person_seen_seq`, a Mark read's
 * `person_read_seq`; only the window's `/seen` and `/read` routes write them),
 * a message the person wrote (not one of the Inbox's own notes or action
 * reports, not a routine's line), an answered question (`picked_at`), a pin,
 * a draft, a paired device, a linked machine or the relay, a snooze, a
 * search. A store not yet returned from SQLite (`inbox.db`) counts as used, so
 * no user of it is cut off. Stops at the first hit. A store too large to read
 * by `deadline` counts as used (kept on when in doubt), so the decision is
 * bounded in time.
 */
export function storeShowsPersonUse(inboxDir: string, deadline: number = Date.now() + INBOX_SCAN_BUDGET_MS): boolean {
  if (existsSync(join(inboxDir, "inbox.db"))) return true;
  if (nonEmptyFile(join(inboxDir, "devices.jsonl"))) return true;
  for (const name of ["pins.json", "machines.json", "relay.json", "snoozes.json", "recent-searches.json"]) {
    if (nonEmptyJson(join(inboxDir, name))) return true;
  }
  for (const folder of ["drafts", "reply-drafts"]) {
    try {
      if (readdirSync(join(inboxDir, folder)).some((name) => name.endsWith(".json"))) return true;
    } catch {
      // No such folder.
    }
  }
  let projects: string[];
  try {
    projects = readdirSync(join(inboxDir, "projects"));
  } catch {
    return false;
  }
  for (const project of projects) {
    if (Date.now() > deadline) return true;
    if (linesMatch(join(inboxDir, "projects", project, "messages.jsonl"), personMessageLine, deadline)) return true;
    if (linesMatch(join(inboxDir, "projects", project, "questions.jsonl"), pickedQuestionLine, deadline)) return true;
  }
  return false;
}

/** How long the one-time decision may read the store (the Claude Code mod waits on it once). */
export const INBOX_SCAN_BUDGET_MS = 5_000;

function nonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function nonEmptyJson(path: string): boolean {
  const text = readText(path);
  if (!text) return false;
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) return value.length > 0;
    return !!value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0;
  } catch {
    return false;
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
function linesMatch(path: string, test: (line: string) => boolean, deadline: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const chunk = Buffer.alloc(1 << 20);
    const decoder = new StringDecoder("utf8");
    let rest = "";
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      if (Date.now() > deadline) return true;
      const text = rest + decoder.write(chunk.subarray(0, read));
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      if (lines.some((line) => line && test(line))) return true;
    }
    rest += decoder.end();
    return rest !== "" && test(rest);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
