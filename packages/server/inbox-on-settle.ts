/**
 * The parts of "is the Inbox on here" (packages/shared/inbox/inbox-on.ts) that
 * edit agents' instruction files and stop the Inbox, so they live with the
 * notes (inbox-agent-notes.ts):
 *
 *  - settleInboxOn: decide an install from before the rule (once) and, for one
 *    decided off with `notes: 'remove'` (only agents ever started its Inbox),
 *    stop an Inbox still running from before the update and remove
 *    Plannotator's own untouched notes, once: what cannot go is
 *    logged and never retried by itself (Turn off tries again). The CLI runs it
 *    at the start of every `plannotator inbox` command and in `plannotator
 *    inbox migrate`, which the Claude Code mod runs once when the record is
 *    missing.
 *  - turnInboxOff: Turn the Inbox off (`plannotator inbox off`, the Settings
 *    switches): the record says off first, so nothing can start the Inbox
 *    again, then the Inbox stops, its start at login goes, then the untouched
 *    notes go.
 *
 * A note the person edited is never touched: each file is judged on its own
 * (removeUntouchedInboxNote), and the edited one stays, named in the result.
 * A removed note's agent is taken out of `inboxAgentNotes.asked`, so turning
 * the Inbox on again writes it back. Every decision and every Turn off leaves
 * one line in `inbox/inbox.log` (`ev: "inbox_on"`).
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_AGENT_LABELS, INBOX_NOTE_AGENT_IDS, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { isInboxOn, readInboxOnRecord, recordInboxOff, turnInboxOn, writeInboxOnRecord, type InboxOnRecord } from "@plannotator/shared/inbox/inbox-on";
import { stopInbox, type InboxStopResult } from "@plannotator/shared/inbox/registry";
import { INBOX_OFF_NOT_SAVED, INBOX_TURN_ON_AGAIN, inboxOnConfigWrite } from "@plannotator/shared/inbox/inbox-on-config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { createAgentEnvironment, type AgentEnvironment } from "./inbox-agents";
import { removeUntouchedInboxNote } from "./inbox-agent-notes";
import { INBOX_LOGIN_ITEM_ENV, inboxLoginItem } from "./inbox-scheduled-login";

/** launchd's label for the start at login (the CLI's run-kind check reads it). */
export { INBOX_LOGIN_LABEL } from "./inbox-scheduled-login";

export { INBOX_TURN_ON_AGAIN };

export interface InboxNotesCleared {
  /** Notes removed, one per file (paths with `~`). */
  removed: { agent: InboxNoteAgentId; path: string }[];
  /** Notes the person edited, left as they are. */
  kept: { agent: InboxNoteAgentId; path: string }[];
  /** Notes that could not be removed, with why. */
  failed: { agent: InboxNoteAgentId; reason: string }[];
}

/** Remove Plannotator's own notes that are still exactly as it wrote them, file by file; never one the person edited. */
export function removeUntouchedInboxNotes(dataDir: string, e: AgentEnvironment = createAgentEnvironment()): InboxNotesCleared {
  const out: InboxNotesCleared = { removed: [], kept: [], failed: [] };
  for (const agent of INBOX_NOTE_AGENT_IDS) {
    let one;
    try {
      one = removeUntouchedInboxNote(agent, dataDir, e);
    } catch (error) {
      out.failed.push({ agent, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const path of one.removed) out.removed.push({ agent, path });
    for (const path of one.kept) out.kept.push({ agent, path });
    for (const failed of one.failed) out.failed.push({ agent, reason: failed.reason });
  }
  if (out.removed.length > 0) {
    // Un-asked, so the Inbox writes these again by itself once the person turns it on.
    const notes = loadConfig({ quiet: true }).inboxAgentNotes;
    const removed = new Set<string>(out.removed.map((note) => note.agent));
    if (Array.isArray(notes?.asked)) saveConfig({ inboxAgentNotes: { ...notes, asked: notes.asked.filter((id) => !removed.has(id)) } });
  }
  return out;
}

/**
 * One line in `inbox/inbox.log` (the start trace's file: every writer appends), always, so what the decision and a
 * Turn off did can be read later. Only where an Inbox ran (the folder exists): a log line never creates it.
 */
export function logInboxOn(dataDir: string, record: Record<string, unknown>): void {
  try {
    const dir = inboxDir(dataDir);
    if (!existsSync(dir)) return;
    appendFileSync(join(dir, "inbox.log"), `${JSON.stringify({ t: Date.now(), ev: "inbox_on", ...record, pid: process.pid })}\n`, { mode: 0o600 });
  } catch {
    // The log never gets in the way.
  }
}

function notesLine(cleared: InboxNotesCleared): Record<string, unknown> {
  return {
    notes_removed: cleared.removed.map((note) => note.path),
    notes_kept: cleared.kept.map((note) => note.path),
    notes_failed: cleared.failed.map((note) => note.reason),
  };
}

/**
 * Decide this install once (an install from before the rule) and finish what
 * an agent-only decision left to do, once. Idempotent: a decided record with
 * nothing pending is only read. Answers whether the Inbox is on.
 */
export async function settleInboxOn(
  dataDir: string,
  options: { environment?: AgentEnvironment; env?: Readonly<Record<string, string | undefined>>; stop?: (dataDir: string) => Promise<InboxStopResult> } = {},
): Promise<boolean> {
  const before = readInboxOnRecord(dataDir);
  // isInboxOn decides an undecided install (and writes the record), the one rule for it.
  const on = isInboxOn(dataDir, options.env ?? process.env);
  const record = readInboxOnRecord(dataDir);
  const e = options.environment ?? createAgentEnvironment();
  // A start at login written before its marker (0.29): marked while on, removed while off, so it never turns the Inbox on.
  await settleOldLoginItem(dataDir, e, record?.on ?? on);
  if (!record) return on;
  if (!before) logInboxOn(dataDir, { decided: record.by, on: record.on });
  if (record.on || record.notes !== "remove") return record.on;
  // Decided off: an Inbox still running from before the update stops, as Turn off stops it, so status and agents agree.
  const stop = await (options.stop ?? ((dir: string) => stopInbox(dir, { escalate: true })))(dataDir).catch(() => undefined);
  const cleared = removeUntouchedInboxNotes(dataDir, e);
  // Decided off: the routines' start at login would bring the Inbox back at the next login.
  const login = await removeLoginItem(dataDir, e);
  // Once: what could not go is logged, never retried by itself (Turn off tries again and names it).
  const next: InboxOnRecord = withoutNotes(record);
  writeInboxOnRecord(dataDir, next, { ifCurrent: record });
  logInboxOn(dataDir, { settled: record.by, ...(stop ? { stop: stop.state } : {}), ...loginLine(login), ...notesLine(cleared) });
  return false;
}

function loginItemOf(dataDir: string, e: AgentEnvironment) {
  return inboxLoginItem({
    platform: e.platform,
    home: e.homeDir,
    argv: [],
    dataDir,
    run: underTest() ? async () => ({ code: 0 }) : async (argv) => ({ code: (await e.run(argv, { timeoutMs: 10_000 })).exitCode }),
  });
}

/** A login item without the marker: given it while the Inbox is on, removed while it is off. Never throws. */
async function settleOldLoginItem(dataDir: string, e: AgentEnvironment, on: boolean): Promise<void> {
  try {
    const login = loginItemOf(dataDir, e);
    if (!login.path || !existsSync(login.path) || readFileSync(login.path, "utf8").includes(INBOX_LOGIN_ITEM_ENV)) return;
    if (on) {
      if (await login.mark()) logInboxOn(dataDir, { login_item_marked: login.path });
      return;
    }
    logInboxOn(dataDir, { settled: "old_login_item", ...loginLine(await removeLoginItem(dataDir, e)) });
  } catch {
    // Read again at the next command; the run itself is still known by its launcher (isOurLoginItem).
  }
}

function withoutNotes(record: InboxOnRecord): InboxOnRecord {
  const { notes: _notes, ...rest } = record;
  return rest;
}

export interface InboxTurnedOff {
  /** Whether the record now says off. */
  recorded: boolean;
  /** What stopping the Inbox did (absent when the caller stops it itself). */
  stop?: InboxStopResult;
  /** The routines' start at login: removed (its path), or could not be removed (its path and why). */
  loginItem?: LoginItemRemoval;
  notes: InboxNotesCleared;
}

function underTest(): boolean {
  return !!process.env.PLANNOTATOR_TEST_SANDBOX || process.env.NODE_ENV === "test";
}

export interface LoginItemRemoval {
  path: string;
  /** Why it could not be removed; absent when it was. */
  error?: string;
}

/**
 * Remove the routines' start at login (inbox-scheduled-login.ts), if there is one. There is one per account,
 * whatever data dir it names, so this removes it either way. Null when there was none; a failure is returned,
 * never swallowed.
 */
async function removeLoginItem(dataDir: string, e: AgentEnvironment): Promise<LoginItemRemoval | null> {
  let path: string | null = null;
  try {
    const login = loginItemOf(dataDir, e);
    path = login.path ?? null;
    if (!path || !existsSync(path)) return null;
    await login.remove();
    return existsSync(path) ? { path, error: "it is still there after removing it" } : { path };
  } catch (error) {
    return path ? { path, error: error instanceof Error ? error.message : String(error) } : null;
  }
}

function loginLine(login: LoginItemRemoval | null): Record<string, unknown> {
  if (!login) return {};
  return login.error ? { login_item_failed: login.path, login_item_error: login.error } : { login_item_removed: login.path };
}

/**
 * Turn the Inbox off: the record says off (with the notes still to remove),
 * the Inbox stops (`stop: false` when the caller is the Inbox itself and stops
 * after answering), the routines' start at login goes (it comes back when the
 * person turns the Inbox on and it starts with routines on), then
 * Plannotator's untouched notes go.
 */
export async function turnInboxOff(dataDir: string, options: { stop?: boolean; environment?: AgentEnvironment; now?: Date } = {}): Promise<InboxTurnedOff> {
  const now = options.now ?? new Date();
  const e = options.environment ?? createAgentEnvironment();
  const recorded = recordInboxOff(dataDir, now, "remove");
  const stop = options.stop === false ? undefined : await stopInbox(dataDir, { escalate: true });
  const loginItem = await removeLoginItem(dataDir, e);
  const notes = removeUntouchedInboxNotes(dataDir, e);
  const pending = readInboxOnRecord(dataDir);
  if (recorded && pending && !pending.on && pending.notes === "remove") {
    writeInboxOnRecord(dataDir, withoutNotes(pending), { ifCurrent: pending });
  }
  logInboxOn(dataDir, { decided: "off", ...loginLine(loginItem), ...notesLine(notes) });
  return { recorded, ...(stop ? { stop } : {}), ...(loginItem ? { loginItem } : {}), notes };
}

/** The lines `plannotator inbox off` prints (and the Settings switches show the first and last of). */
export function inboxOffReport(off: InboxTurnedOff): string[] {
  const lines = [off.recorded ? "The Plannotator Inbox is off on this computer: agents lose it from their next session." : INBOX_OFF_NOT_SAVED];
  if (off.stop?.state === "still_running") lines.push(`The running Inbox (pid ${off.stop.pid}) did not stop; stop it with plannotator inbox stop.`);
  if (off.loginItem && !off.loginItem.error) lines.push("Removed the Inbox's start at login; it comes back with routines when you turn the Inbox on.");
  if (off.loginItem?.error) lines.push(`Could not remove the Inbox's start at login (${off.loginItem.path}): ${off.loginItem.error}. Remove that file yourself, or it may start the Inbox again at login.`);
  for (const note of off.notes.removed) lines.push(`Removed Plannotator's note for ${INBOX_AGENT_LABELS[note.agent]} from ${note.path}.`);
  for (const note of off.notes.kept) lines.push(`Left the note for ${INBOX_AGENT_LABELS[note.agent]} in ${note.path}: you edited it.`);
  for (const note of off.notes.failed) lines.push(`Could not remove the note for ${INBOX_AGENT_LABELS[note.agent]}: ${note.reason}`);
  if (off.recorded) lines.push(INBOX_TURN_ON_AGAIN);
  return lines;
}

/** The Bun servers' answer to Settings' `{ inboxOn }` (packages/shared/inbox/inbox-on-config.ts). */
export function inboxOnConfigResponse(on: boolean): Promise<Response> {
  return inboxOnConfigWrite(on, async () => (await turnInboxOff(getPlannotatorDataDir())).recorded, () => turnInboxOn("settings", getPlannotatorDataDir())).then(({ status, body }) => Response.json(body, { status }));
}
