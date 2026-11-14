/**
 * Plannotator Inbox: the threads the person put in the list's Priority group.
 *
 *   inbox/priority.json   { v: 1, threads: [{ thread_id, at }], off: [{ thread_id, at }] }, 0600, written whole (temp, then rename)
 *
 * A file outside the store's JSONL, like pins and snoozes: it belongs to the
 * person and the window, and must never enter the event log, which agents'
 * cursors, the phone relay and search read. `threads` are the person's adds;
 * `off` are the threads where the person took an agent's ask out, each with
 * when. A deleted thread leaves the file.
 */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId, type InboxPriorityBefore, type InboxPriorityEntry } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const INBOX_PRIORITY_FILE = "priority.json";

export interface InboxPriorityState {
  threads: InboxPriorityEntry[];
  off: InboxPriorityEntry[];
}

function fileOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_PRIORITY_FILE);
}

function entries(value: unknown): InboxPriorityEntry[] {
  if (!Array.isArray(value)) return [];
  const out: InboxPriorityEntry[] = [];
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    const entry = item as { thread_id?: unknown; at?: unknown } | null;
    if (!entry || typeof entry !== "object" || !isInboxId("msg", entry.thread_id) || typeof entry.at !== "string") continue;
    if (seen.has(entry.thread_id)) continue;
    seen.add(entry.thread_id);
    out.push({ thread_id: entry.thread_id, at: entry.at });
  }
  return out;
}

/** The state on disk. A file that does not parse reads as empty; a bad or repeated entry is skipped. */
export function readInboxPriority(inboxDirPath: string): InboxPriorityState {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(fileOf(inboxDirPath), "utf8"));
  } catch {
    return { threads: [], off: [] };
  }
  const file = value as { v?: unknown; threads?: unknown; off?: unknown } | null;
  if (!file || typeof file !== "object" || file.v !== 1) return { threads: [], off: [] };
  return { threads: entries(file.threads), off: entries(file.off) };
}

/**
 * What priority.json holds before a write: nothing, a v1 file, a file this
 * Plannotator cannot read, or a newer version's file. readInboxPriority reads
 * the last two as empty, so a write must never simply replace them.
 */
function fileState(inboxDirPath: string): "missing" | "ok" | "bad" | "newer" {
  let raw: string;
  try {
    raw = readFileSync(fileOf(inboxDirPath), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "bad";
  }
  try {
    const file = JSON.parse(raw) as { v?: unknown } | null;
    if (!file || typeof file !== "object" || Array.isArray(file)) return "bad";
    if (typeof file.v === "number" && file.v > 1) return "newer";
    return file.v === 1 ? "ok" : "bad";
  } catch {
    return "bad";
  }
}

/**
 * Write the state whole (temp, then rename), 0600. A newer version's file is
 * refused (`priority_newer`), never replaced; a file that cannot be read is
 * moved aside first, so nothing of the person's is lost. Both lists empty
 * removes the file.
 */
export function writeInboxPriority(inboxDirPath: string, state: InboxPriorityState): void {
  const path = fileOf(inboxDirPath);
  const was = fileState(inboxDirPath);
  if (was === "newer") throw new InboxError("priority_newer", "A newer Plannotator keeps your Priority here: update this one to change it.");
  if (was === "bad") {
    try {
      renameSync(path, `${path}.unreadable-${Date.now()}`);
    } catch {
      // Gone already, or not movable: the write below says which.
    }
  }
  if (state.threads.length === 0 && state.off.length === 0) {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return;
  }
  const wire = (list: readonly InboxPriorityEntry[]) => list.map(({ thread_id, at }) => ({ thread_id, at }));
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, threads: wire(state.threads), off: wire(state.off) })}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created: a temp file a crash left keeps its old mode.
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** The checks on an Undo's `restore`: `{ at, off_at }`, each an ISO time or null. */
export function checkInboxPriorityRestore(value: unknown): InboxPriorityBefore {
  const restore = value as { at?: unknown; off_at?: unknown } | null;
  const time = (v: unknown) => v === null || (typeof v === "string" && v.length <= 64 && !Number.isNaN(Date.parse(v)));
  if (!restore || typeof restore !== "object" || Array.isArray(restore) || !time(restore.at) || !time(restore.off_at)) {
    throw new InboxError("validation_error", "restore: { at, off_at }, each an ISO time or null.", { field: "restore" });
  }
  return { at: restore.at as string | null, off_at: restore.off_at as string | null };
}
