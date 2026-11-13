/**
 * What the person and the debug log hear about a move between the JSONL files and `inbox.db` (`open-store.ts`).
 *
 * The one line the owner approved (design brief "The Inbox on SQLite", section 8): shown only while a move runs past
 * 2 s, on the terminal that started the Inbox (the server's own stderr when it runs in the foreground, and the
 * starter's while it waits for a detached one). The window cannot show it: the server is not listening yet.
 */
import type { InboxImportOutcome } from "./import";
import type { InboxReturnOutcome } from "./return-to-files";

export const INBOX_UPGRADING_LINE = "Upgrading your Inbox…";

/** How long a move runs before the person is told (the owner's "over 2 s"). */
export const INBOX_IMPORT_SLOW_MS = 2_000;

/** A move is running now (`upgrade-marker.ts`). */
export { inboxUpgradeRunning } from "./upgrade-marker";

/**
 * How long a starter waits for a move that is still running before it gives up (its usual wait is 20 s). Generous:
 * a move of a very large Inbox on a slow disk. The Inbox itself carries on either way.
 */
export const INBOX_UPGRADE_WAIT_MAX_MS = 10 * 60_000;

/** The debug log's `store_move` line: what happened and how long it took, no words from the records. */
export function storeMoveNote(moved: InboxImportOutcome | InboxReturnOutcome): Record<string, unknown> {
  switch (moved.status) {
    case "imported":
      return { status: moved.status, lines: moved.lines, ms: moved.ms, apart: moved.apart, ...moved.phases };
    case "returned":
      return { status: moved.status, lines: moved.lines, ms: moved.ms };
    case "kept_files":
    case "kept_db":
      return { status: moved.status, reason: moved.reason };
    default:
      return { status: moved.status };
  }
}
