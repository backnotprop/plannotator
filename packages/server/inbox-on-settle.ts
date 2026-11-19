/**
 * The parts of "is the Inbox on here" (packages/shared/inbox/inbox-on.ts) that
 * edit agents' instruction files and stop the Inbox, so they live with the
 * notes (inbox-agent-notes.ts):
 *
 *  - settleInboxOn: decide an install from before the rule (once) and, for one
 *    decided off with `notes: 'remove'` (only agents ever started its Inbox),
 *    remove Plannotator's own untouched notes. The CLI runs it at the start of
 *    every `plannotator inbox` command and in `plannotator inbox migrate`,
 *    which the Claude Code mod runs once when the record is missing.
 *  - turnInboxOff: Turn the Inbox off (`plannotator inbox off`, the Settings
 *    switches): the record says off first, so nothing can start the Inbox
 *    again, then the Inbox stops, then the untouched notes go.
 *
 * A note the person edited is never touched (noteStatus `edited`); it stays,
 * named in the result. A removed note's agent is taken out of
 * `inboxAgentNotes.asked`, so turning the Inbox on again writes it back.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { INBOX_AGENT_LABELS, INBOX_NOTE_AGENT_IDS, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { resolveInboxDebug } from "@plannotator/shared/inbox/debug-log";
import { isInboxOn, readInboxOnRecord, recordInboxOff, writeInboxOnRecord, type InboxOnRecord } from "@plannotator/shared/inbox/inbox-on";
import { stopInbox, type InboxStopResult } from "@plannotator/shared/inbox/registry";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { createAgentEnvironment, type AgentEnvironment } from "./inbox-agents";
import { noteStatus, removeInboxNote } from "./inbox-agent-notes";

export interface InboxNotesCleared {
  /** Notes removed (paths with `~`). */
  removed: { agent: InboxNoteAgentId; path: string }[];
  /** Notes the person edited, left as they are. */
  kept: { agent: InboxNoteAgentId; path: string }[];
  /** Notes that could not be removed, with why. */
  failed: { agent: InboxNoteAgentId; reason: string }[];
}

/** Remove Plannotator's own notes that are still exactly as it wrote them; never one the person edited. */
export function removeUntouchedInboxNotes(dataDir: string, e: AgentEnvironment = createAgentEnvironment()): InboxNotesCleared {
  const out: InboxNotesCleared = { removed: [], kept: [], failed: [] };
  for (const agent of INBOX_NOTE_AGENT_IDS) {
    if (agent === "cursor") continue;
    let status;
    try {
      status = noteStatus(agent, dataDir, e);
    } catch (error) {
      out.failed.push({ agent, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (status.state === "edited") {
      out.kept.push({ agent, path: status.path ?? "" });
      continue;
    }
    if (status.state !== "added") continue;
    const change = removeInboxNote(agent, dataDir, e);
    if (change.ok) out.removed.push({ agent, path: change.path });
    else out.failed.push({ agent, reason: change.reason });
  }
  if (out.removed.length > 0) {
    // Un-asked, so the Inbox writes these again by itself once the person turns it on.
    const notes = loadConfig().inboxAgentNotes;
    const removed = new Set<string>(out.removed.map((note) => note.agent));
    if (Array.isArray(notes?.asked)) saveConfig({ inboxAgentNotes: { ...notes, asked: notes.asked.filter((id) => !removed.has(id)) } });
  }
  return out;
}

/** One line in `inbox/inbox.log` with the Inbox's debug log on (the start trace's file: every writer appends). */
export function logInboxOn(dataDir: string, record: Record<string, unknown>, env: Record<string, string | undefined> = process.env): void {
  try {
    if (!resolveInboxDebug(loadConfig({ quiet: true }), env)) return;
    const dir = inboxDir(dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, "inbox.log"), `${JSON.stringify({ t: Date.now(), ev: "inbox_on", ...record, pid: process.pid })}\n`, { mode: 0o600 });
  } catch {
    // The log never gets in the way.
  }
}

/**
 * Decide this install once (an install from before the rule) and finish what
 * an off record left to do. Idempotent: a decided record with nothing pending
 * is only read. Answers whether the Inbox is on.
 */
export function settleInboxOn(dataDir: string, options: { environment?: AgentEnvironment; env?: Readonly<Record<string, string | undefined>> } = {}): boolean {
  const before = readInboxOnRecord(dataDir);
  // isInboxOn decides an undecided install (and writes the record), the one rule for it.
  const on = isInboxOn(dataDir, options.env ?? process.env);
  const record = readInboxOnRecord(dataDir);
  if (!record) return on;
  if (!before) logInboxOn(dataDir, { decided: record.by, on: record.on });
  if (record.on || record.notes !== "remove") return record.on;
  const cleared = removeUntouchedInboxNotes(dataDir, options.environment);
  logInboxOn(dataDir, { notes_removed: cleared.removed.length, notes_kept: cleared.kept.length, notes_failed: cleared.failed.length });
  // A note that could not go is tried again next time; otherwise nothing is pending any more.
  if (cleared.failed.length === 0) writeInboxOnRecord(dataDir, withoutNotes(record));
  return false;
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
  notes: InboxNotesCleared;
}

/**
 * Turn the Inbox off: the record says off (with the notes still to remove),
 * the Inbox stops (`stop: false` when the caller is the Inbox itself and stops
 * after answering), then Plannotator's untouched notes go.
 */
export async function turnInboxOff(dataDir: string, options: { stop?: boolean; environment?: AgentEnvironment; now?: Date } = {}): Promise<InboxTurnedOff> {
  const now = options.now ?? new Date();
  const recorded = recordInboxOff(dataDir, now, "remove");
  const stop = options.stop === false ? undefined : await stopInbox(dataDir, { escalate: true });
  const notes = removeUntouchedInboxNotes(dataDir, options.environment);
  if (recorded && notes.failed.length === 0) recordInboxOff(dataDir, now);
  logInboxOn(dataDir, { decided: "off", notes_removed: notes.removed.length, notes_kept: notes.kept.length, notes_failed: notes.failed.length });
  return { recorded, ...(stop ? { stop } : {}), notes };
}

/** The lines `plannotator inbox off` prints (and the Settings switches show the first and last of). */
export function inboxOffReport(off: InboxTurnedOff): string[] {
  const lines = [off.recorded ? "The Plannotator Inbox is off on this computer: agents lose it from their next session, and nothing starts it." : "Could not turn the Plannotator Inbox off: state.json in Plannotator's data folder could not be written."];
  if (off.stop?.state === "still_running") lines.push(`The running Inbox (pid ${off.stop.pid}) did not stop; stop it with plannotator inbox stop.`);
  for (const note of off.notes.removed) lines.push(`Removed Plannotator's note for ${INBOX_AGENT_LABELS[note.agent]} from ${note.path}.`);
  for (const note of off.notes.kept) lines.push(`Left the note for ${INBOX_AGENT_LABELS[note.agent]} in ${note.path}: you edited it.`);
  for (const note of off.notes.failed) lines.push(`Could not remove the note for ${INBOX_AGENT_LABELS[note.agent]}: ${note.reason}`);
  if (off.recorded) lines.push(INBOX_TURN_ON_AGAIN);
  return lines;
}

/** How to turn it back on, said after every Turn off. */
export const INBOX_TURN_ON_AGAIN = "Turn it back on any time with plannotator inbox.";
