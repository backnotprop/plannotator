/** The last look at the Board, saved in inbox/board.json (0600, written whole). `seen_seq` is a seq, not a time, so two writes in one millisecond are told apart. Outside the store's JSONL: a look never enters the event log. */

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INBOX_BOARD_FILE = "board.json";

export function isInboxBoardSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readInboxBoardSeen(inboxDirPath: string): number | null {
  try {
    const value = JSON.parse(readFileSync(join(inboxDirPath, INBOX_BOARD_FILE), "utf8")) as { v?: unknown; seen_seq?: unknown } | null;
    if (!value || typeof value !== "object" || value.v !== 2 || !isInboxBoardSeq(value.seen_seq)) return null;
    return value.seen_seq;
  } catch {
    return null;
  }
}

/** Clamped to `cursor` so a look never runs ahead of the store, and never goes back. */
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
