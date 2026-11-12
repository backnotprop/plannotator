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
  }
  renameSync(temp, file);
  return next;
}
