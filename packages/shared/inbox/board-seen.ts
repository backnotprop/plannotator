/**
 * Plannotator Inbox: the person's last look at the Board (approval
 * "inbox-board-signal": a card is bold when unread, "like mail").
 *
 *   inbox/board.json   { v: 2, seen_seq: <store seq> }, 0600, written whole (temp, then rename)
 *
 * `seen_seq` is the store's cursor when the Board the person opened was read:
 * every line up to it was on the page. A card an agent wrote to in a later
 * line is unread (`isInboxCardUnread`, by the card's `heard_seq`). A seq, not
 * a time: two writes in one millisecond are told apart, and a look can never
 * run ahead of the store (the route clamps it to the cursor). A file outside
 * the store's JSONL, like pins: a look is window furniture and never enters
 * the event log that agents, the phone relay and search read. A v1 file (a
 * time, from a build of this branch before the review) reads as no look.
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INBOX_BOARD_FILE = "board.json";

/** Whether a value is a store seq a look can name: a whole number, 0 or more. */
export function isInboxBoardSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The person's last look at the Board, or null (never opened, or a file that does not read). */
export function readInboxBoardSeen(inboxDirPath: string): number | null {
  try {
    const value = JSON.parse(readFileSync(join(inboxDirPath, INBOX_BOARD_FILE), "utf8")) as { v?: unknown; seen_seq?: unknown } | null;
    if (!value || typeof value !== "object" || value.v !== 2 || !isInboxBoardSeq(value.seen_seq)) return null;
    return value.seen_seq;
  } catch {
    return null;
  }
}

/**
 * Record a look through `through`, clamped to `cursor` (the store's seq now:
 * a look never runs ahead of what was written). A look never goes back: an
 * older seq (a second tab that read the Board earlier) leaves the newer one.
 * Answers the look now on disk.
 */
export function writeInboxBoardSeen(inboxDirPath: string, through: number, cursor: number): number {
  const next = Math.min(through, cursor);
  const current = readInboxBoardSeen(inboxDirPath);
  if (current !== null && current >= next) return current;
  const file = join(inboxDirPath, INBOX_BOARD_FILE);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 2, seen_seq: next })}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Windows: the mode is a no-op.
  }
  renameSync(temp, file);
  return next;
}
