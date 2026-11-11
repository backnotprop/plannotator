/**
 * What the person and the debug log hear about a move between the JSONL files and `inbox.db` (`open-store.ts`).
 *
 * The one line the owner approved (design brief "The Inbox on SQLite", section 8): shown only while a move runs past
 * 2 s, on the terminal that started the Inbox (the server's own stderr when it runs in the foreground, and the
 * starter's while it waits for a detached one). The window cannot show it: the server is not listening yet.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "../../schema";
import type { InboxImportOutcome } from "./import";
import { INBOX_DB_IMPORTING } from "./move-files";
import type { InboxReturnOutcome } from "./return-to-files";

export const INBOX_UPGRADING_LINE = "Upgrading your Inbox…";

/** How long a move runs before the person is told (the owner's "over 2 s"). */
export const INBOX_IMPORT_SLOW_MS = 2_000;

/** A move is running now: its database is being written under the importing name. */
export function inboxUpgradeRunning(dataDir: string): boolean {
  return existsSync(join(inboxDir(dataDir), INBOX_DB_IMPORTING));
}

/** The debug log's `store_move` line: what happened and how long it took, no words from the records. */
export function storeMoveNote(moved: InboxImportOutcome | InboxReturnOutcome): Record<string, unknown> {
  switch (moved.status) {
    case "imported":
      return { status: moved.status, lines: moved.lines, ms: moved.ms, ...moved.phases };
    case "returned":
      return { status: moved.status, lines: moved.lines, ms: moved.ms };
    case "kept_files":
    case "kept_db":
      return { status: moved.status, reason: moved.reason };
    default:
      return { status: moved.status };
  }
}
