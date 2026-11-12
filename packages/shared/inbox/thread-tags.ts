/**
 * Plannotator Inbox: the tags the person put on a thread or took off it
 * (approval "inbox-thread-tags", step 1).
 *
 *   inbox/thread-tags.json   { v: 1, marks: [{ thread_id, tag, on, seq, at }] }, 0600, written whole (temp, then rename)
 *
 * A tag is an initiative record (`ini_` id, initiatives in the event log); this
 * file holds only the person's own marks on threads, one per (thread, tag), the
 * latest winning: `on: true` from Add tag, `on: false` from an untick or Remove
 * from. `seq` is the store's cursor when the mark was made, so a `#Name` the
 * person types later in the thread (a message with a higher seq) puts it back,
 * and one typed earlier does not. A file outside the event log, like pins and
 * snoozes: agents' cursors, the phone relay and search never read it, and an
 * Inbox from before tags never opens it. A deleted thread leaves the file; a
 * deleted tag keeps its marks, so its Undo brings its threads back.
 */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const INBOX_THREAD_TAGS_FILE = "thread-tags.json";

export interface InboxThreadTagMark {
  thread_id: string;
  /** The tag: an initiative's `ini_` id. */
  tag: string;
  /** True: the person put the thread in the tag; false: they took it out. */
  on: boolean;
  /** The store's cursor when the mark was made. */
  seq: number;
  at: string;
}

function fileOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_THREAD_TAGS_FILE);
}

/** The marks on disk. A file that does not parse (or a newer version's) reads as none; a bad entry is skipped, and of two for one pair the later one stays. */
export function readInboxThreadTags(inboxDirPath: string): InboxThreadTagMark[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(fileOf(inboxDirPath), "utf8"));
  } catch {
    return [];
  }
  const file = value as { v?: unknown; marks?: unknown } | null;
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.marks)) return [];
  const byPair = new Map<string, InboxThreadTagMark>();
  for (const entry of file.marks as unknown[]) {
    const mark = entry as Partial<Record<keyof InboxThreadTagMark, unknown>> | null;
    if (!mark || typeof mark !== "object" || !isInboxId("msg", mark.thread_id) || !isInboxId("ini", mark.tag)) continue;
    if (typeof mark.on !== "boolean" || typeof mark.seq !== "number" || !Number.isSafeInteger(mark.seq) || mark.seq < 0 || typeof mark.at !== "string") continue;
    const key = `${mark.thread_id}\0${mark.tag}`;
    byPair.delete(key);
    byPair.set(key, { thread_id: mark.thread_id, tag: mark.tag, on: mark.on, seq: mark.seq, at: mark.at });
  }
  return [...byPair.values()];
}

/** What thread-tags.json holds before a write (as pins.json): a newer version's file is never written over. */
function fileState(inboxDirPath: string): "missing" | "ok" | "bad" | "newer" {
  let raw: string;
  try {
    raw = readFileSync(fileOf(inboxDirPath), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "bad";
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "bad";
  }
  const file = value as { v?: unknown; marks?: unknown } | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) return "bad";
  if (typeof file.v === "number" && file.v > 1) return "newer";
  return file.v === 1 && Array.isArray(file.marks) ? "ok" : "bad";
}

/**
 * Write the marks whole (owner-only). None removes the file. A file a newer
 * Plannotator wrote is refused; one that cannot be read is moved aside first
 * (`thread-tags.json.unreadable-<time>`), as pins.json is.
 */
export function writeInboxThreadTags(inboxDirPath: string, marks: readonly InboxThreadTagMark[]): void {
  const file = fileOf(inboxDirPath);
  const state = fileState(inboxDirPath);
  if (state === "newer") throw new InboxError("thread_tags_newer", "thread-tags.json was written by a newer Plannotator; update Plannotator to change tags.");
  if (state === "bad") renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (marks.length === 0) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  const wire = marks.map((m) => ({ thread_id: m.thread_id, tag: m.tag, on: m.on, seq: m.seq, at: m.at }));
  writeFileSync(temp, `${JSON.stringify({ v: 1, marks: wire })}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
