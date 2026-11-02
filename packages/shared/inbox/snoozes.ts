/**
 * Plannotator Inbox: snoozed threads (approval "inbox-snooze",
 * .product/approved/inbox-snooze/).
 *
 *   inbox/snoozes.json   { v: 1, snoozes: [{ thread_id, until, at }] }, 0600, written whole (temp, then rename)
 *
 * A file outside the store's JSONL, like pins: a snooze belongs to the person
 * and the window, and must never enter the event log, which agents' cursors,
 * the phone relay and search read. It writes no line and takes no seq, so an
 * agent sees nothing: `read_thread`, sections and cursors are unchanged and a
 * question stays open. An entry outlives its `until` until the person reads
 * the thread, which is what keeps a returned thread's clock across a restart.
 * A deleted thread leaves the file.
 */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId } from "@plannotator/core/inbox-types";
import type { InboxSnooze } from "@plannotator/core/inbox-snooze";
import { InboxError } from "./schema";

export const INBOX_SNOOZES_FILE = "snoozes.json";

function fileOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_SNOOZES_FILE);
}

/** The snoozes on disk. A file that does not parse reads as none; a bad or repeated entry is skipped. */
export function readInboxSnoozes(inboxDirPath: string): InboxSnooze[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(fileOf(inboxDirPath), "utf8"));
  } catch {
    return [];
  }
  const file = value as { v?: unknown; snoozes?: unknown } | null;
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.snoozes)) return [];
  const out: InboxSnooze[] = [];
  const seen = new Set<string>();
  for (const entry of file.snoozes as unknown[]) {
    const snooze = entry as { thread_id?: unknown; until?: unknown; at?: unknown } | null;
    if (!snooze || typeof snooze !== "object" || !isInboxId("msg", snooze.thread_id)) continue;
    if (typeof snooze.until !== "string" || Number.isNaN(Date.parse(snooze.until)) || typeof snooze.at !== "string") continue;
    if (seen.has(snooze.thread_id)) continue;
    seen.add(snooze.thread_id);
    out.push({ thread_id: snooze.thread_id, until: snooze.until, at: snooze.at });
  }
  return out;
}

/**
 * What snoozes.json holds before a write: nothing, a v1 file, a file this
 * Plannotator cannot read, or a newer version's file. readInboxSnoozes reads
 * the last two as no snoozes, so a write must never simply replace them.
 */
function fileState(inboxDirPath: string): "missing" | "ok" | "bad" | "newer" {
  let raw: string;
  try {
    raw = readFileSync(fileOf(inboxDirPath), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "bad";
  }
  try {
    const file = JSON.parse(raw) as { v?: unknown; snoozes?: unknown } | null;
    if (!file || typeof file !== "object") return "bad";
    if (typeof file.v === "number" && file.v > 1) return "newer";
    return file.v === 1 && Array.isArray(file.snoozes) ? "ok" : "bad";
  } catch {
    return "bad";
  }
}

/**
 * Write the snoozes whole (temp, then rename), 0600. A newer version's file is
 * refused (`snoozes_newer`), never replaced; a file that cannot be read is
 * moved aside first, so nothing of the person's is lost. No snoozes left
 * removes the file.
 */
export function writeInboxSnoozes(inboxDirPath: string, snoozes: readonly InboxSnooze[]): void {
  const path = fileOf(inboxDirPath);
  const state = fileState(inboxDirPath);
  if (state === "newer") throw new InboxError("snoozes_newer", "A newer Plannotator keeps your snoozes here: update this one to change them.");
  if (state === "bad") {
    try {
      renameSync(path, `${path}.unreadable-${Date.now()}`);
    } catch {
      // Gone already, or not movable: the write below says which.
    }
  }
  if (snoozes.length === 0) {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return;
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, snoozes: snoozes.map(({ thread_id, until, at }) => ({ thread_id, until, at })) })}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
