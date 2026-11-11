import type { InboxImportOutcome } from "./import";
import type { InboxReturnOutcome } from "./return-to-files";

export const INBOX_UPGRADING_LINE = "Upgrading your Inbox…";

/** How long a move runs before the person is told. */
export const INBOX_IMPORT_SLOW_MS = 2_000;

export { inboxUpgradeRunning } from "./upgrade-marker";

/** Generous: a very large Inbox on a slow disk. The Inbox carries on when a starter gives up. */
export const INBOX_UPGRADE_WAIT_MAX_MS = 10 * 60_000;

/** The debug log's `store_move` line: no words from the records. */
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
