/**
 * Plannotator Inbox: threads pinned to the window's sidebar (approval
 * "inbox-pinned-threads", .product/approved/inbox-pinned-threads/).
 *
 *   inbox/pins.json   { v: 1, pins: [{ thread_id, pinned_at }] }, in pin order, 0600, written whole (temp, then rename)
 *
 * A file outside the store's JSONL, like reply drafts: a pin is window
 * furniture and must never enter the event log, which agents' cursors, the
 * phone relay and search read. A pin writes no line and takes no seq. There
 * is no limit on pins (the owner's decision), and an archived thread stays
 * pinned; a deleted thread leaves the file.
 */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId, type InboxPin } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const INBOX_PINS_FILE = "pins.json";

/** The most thread ids one order may name (a bound on a request body, not a limit on pins). */
export const INBOX_PIN_ORDER_MAX = 10_000;

function fileOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_PINS_FILE);
}

/** The pins on disk, in order. A file that does not parse reads as none; a bad or repeated entry is skipped. */
export function readInboxPins(inboxDirPath: string): InboxPin[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(fileOf(inboxDirPath), "utf8"));
  } catch {
    return [];
  }
  const file = value as { v?: unknown; pins?: unknown } | null;
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.pins)) return [];
  const out: InboxPin[] = [];
  const seen = new Set<string>();
  for (const entry of file.pins as unknown[]) {
    const pin = entry as { thread_id?: unknown; pinned_at?: unknown } | null;
    if (!pin || typeof pin !== "object" || !isInboxId("msg", pin.thread_id) || typeof pin.pinned_at !== "string") continue;
    if (seen.has(pin.thread_id)) continue;
    seen.add(pin.thread_id);
    out.push({ thread_id: pin.thread_id, pinned_at: pin.pinned_at });
  }
  return out;
}

/**
 * What pins.json holds before a write: nothing, a v1 file, a file this
 * Plannotator cannot read (not JSON, not an object, unreadable), or a newer
 * version's file. readInboxPins reads the last two as no pins, so a write must
 * never simply replace them.
 */
export function inboxPinsFileState(inboxDirPath: string): "missing" | "ok" | "bad" | "newer" {
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
  const file = value as { v?: unknown; pins?: unknown } | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) return "bad";
  if (typeof file.v === "number" && file.v > 1) return "newer";
  return file.v === 1 && Array.isArray(file.pins) ? "ok" : "bad";
}

/**
 * Write the pins whole (owner-only). No pins removes the file. A pins.json a
 * newer Plannotator wrote is never written over (refused: its pins come back
 * with that version); one that cannot be read is moved aside first
 * (`pins.json.unreadable-<time>`, kept for the person), since pins.json is the
 * Inbox's own file and refusing would leave pinning broken for good.
 */
export function writeInboxPins(inboxDirPath: string, pins: readonly InboxPin[]): void {
  const file = fileOf(inboxDirPath);
  const state = inboxPinsFileState(inboxDirPath);
  if (state === "newer") {
    throw new InboxError("pins_newer", "pins.json was written by a newer Plannotator; update Plannotator to change pins.");
  }
  if (state === "bad") renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (pins.length === 0) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, pins: pins.map((pin) => ({ thread_id: pin.thread_id, pinned_at: pin.pinned_at })) })}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created: a temp file a crash left keeps its old mode.
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/** The checks on an order (`POST /api/inbox/pins`): a list of distinct thread ids. */
export function checkInboxPinOrder(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > INBOX_PIN_ORDER_MAX || !value.every((id) => isInboxId("msg", id))) {
    throw new InboxError("validation_error", "order: a list of thread ids (msg_), in the order they show.", { field: "order" });
  }
  if (new Set(value).size !== value.length) throw new InboxError("validation_error", "order: a thread id appears twice.", { field: "order" });
  return value as string[];
}

/** Unpin's Undo (`POST /api/inbox/pins { restore }`): one thread, where it was and when it was pinned. */
export interface InboxPinRestore {
  thread_id: string;
  index: number;
  pinned_at: string;
}

/** The checks on a restore: a thread id, a whole index, and an ISO time. */
export function checkInboxPinRestore(value: unknown): InboxPinRestore {
  const restore = value as { thread_id?: unknown; index?: unknown; pinned_at?: unknown } | null;
  if (
    !restore ||
    typeof restore !== "object" ||
    !isInboxId("msg", restore.thread_id) ||
    typeof restore.index !== "number" ||
    !Number.isInteger(restore.index) ||
    restore.index < 0 ||
    restore.index > INBOX_PIN_ORDER_MAX ||
    typeof restore.pinned_at !== "string" ||
    restore.pinned_at.length > 64 ||
    Number.isNaN(Date.parse(restore.pinned_at))
  ) {
    throw new InboxError("validation_error", "restore: { thread_id (msg_), index (a whole number), pinned_at (an ISO time) }.", { field: "restore" });
  }
  return { thread_id: restore.thread_id, index: restore.index, pinned_at: restore.pinned_at };
}
