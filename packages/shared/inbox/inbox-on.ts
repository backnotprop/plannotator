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

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { saveConfig } from "../config";
import { getPlannotatorDataDir } from "../data-dir";
import {
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
 * carries) or with `PLANNOTATOR_TEST_INBOX_ON=1` (the Inbox's browser proofs,
 * whose specs do not all carry the sandbox). So the suites that start an
 * Inbox in a fresh scratch data dir keep doing so, while a test that turns the
 * Inbox off (a record) or sets `PLANNOTATOR_TEST_INBOX_ON=0` sees the real
 * rule. A person's real data dir is never a scratch folder, so neither can
 * turn their Inbox on.
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
  if (knob !== "1" && !env.PLANNOTATOR_TEST_SANDBOX) return false;
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

/**
 * The one-time decision for an install from before the rule, written to
 * state.json. Returns the record (unchanged when one is already there).
 */
export function decideExistingInstall(dataDir: string = getPlannotatorDataDir(), now: Date = new Date()): InboxOnRecord {
  const known = readInboxOnRecord(dataDir);
  if (known) return known;
  const ranHere = existsSync(join(dataDir, "inbox"));
  const use = ranHere ? inboxUseOnDisk(dataDir) : null;
  const by: InboxOnBy = use === "used" ? "update-used" : use === "ran" ? "update-ran" : ranHere ? "update-agent-only" : "update-never-ran";
  const record: InboxOnRecord = { on: use !== null, at: now.toISOString(), by, ...(by === "update-agent-only" ? { notes: "remove" as const } : {}) };
  writeInboxOnRecord(dataDir, record);
  return record;
}

/** The person turned the Inbox on (their own `plannotator inbox`, `/plannotator-inbox`, `plannotator inbox on`, a Turn on switch). */
export function turnInboxOn(by: InboxOnBy, dataDir: string = getPlannotatorDataDir(), now: Date = new Date()): boolean {
  const known = readInboxOnRecord(dataDir);
  if (known?.on === true && !known.notes) return true;
  return writeInboxOnRecord(dataDir, { on: true, at: now.toISOString(), by });
}

/** Turn the Inbox off: the record says off (the caller stops the Inbox and removes the notes). */
export function recordInboxOff(dataDir: string = getPlannotatorDataDir(), now: Date = new Date(), notes?: "remove"): boolean {
  return writeInboxOnRecord(dataDir, { on: false, at: now.toISOString(), by: "off", ...(notes ? { notes } : {}) });
}

/** Write the record (state.json, under config.json's lock). Only this file's functions call it. */
export function writeInboxOnRecord(dataDir: string, record: InboxOnRecord): boolean {
  // saveConfig writes the data dir this process resolves; every caller passes that same folder.
  if (realOr(dataDir) !== realOr(getPlannotatorDataDir())) return false;
  return saveConfig({ [INBOX_ON_KEY]: record });
}

/**
 * What an install from before the rule shows of the person's own use of the
 * Inbox: the cheap files (inboxUseFromFiles), then the store itself. null:
 * nothing the person did (only agents started it, or it never ran).
 */
export function inboxUseOnDisk(dataDir: string): InboxUseEvidence | null {
  const files = inboxUseFromFiles({
    config: readText(join(dataDir, "config.json")),
    state: readText(join(dataDir, INBOX_ON_FILE)),
    agentsFile: existsSync(join(dataDir, "inbox", "agents.json")),
  });
  if (files === "used") return "used";
  if (storeShowsPersonUse(join(dataDir, "inbox"))) return "used";
  return files;
}

/**
 * Whether the Inbox's store holds something only a person in the window (or a
 * paired phone) leaves: a look at a thread (`person_seen_seq`, a Mark read's
 * `person_read_seq`; only the window's `/seen` and `/read` routes write them),
 * a message the person wrote (not one of the Inbox's own notes or action
 * reports, not a routine's line), an answered question (`picked_at`), a pin,
 * a draft, or a paired device. A store not yet returned from SQLite
 * (`inbox.db`) counts as used, so no user of it is cut off. Stops at the
 * first hit.
 */
export function storeShowsPersonUse(inboxDir: string): boolean {
  if (existsSync(join(inboxDir, "inbox.db"))) return true;
  if (nonEmptyFile(join(inboxDir, "devices.jsonl"))) return true;
  if (nonEmptyJson(join(inboxDir, "pins.json"))) return true;
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
    if (linesMatch(join(inboxDir, "projects", project, "messages.jsonl"), personMessageLine)) return true;
    if (linesMatch(join(inboxDir, "projects", project, "questions.jsonl"), pickedQuestionLine)) return true;
  }
  return false;
}

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

/** Whether any line of a JSONL file passes `test`, read in chunks so a large store stops at the first hit. */
function linesMatch(path: string, test: (line: string) => boolean): boolean {
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
