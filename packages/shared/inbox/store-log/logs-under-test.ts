/** Test-only: a new record log joins this list. */
import { jsonlInboxLog } from "./jsonl-log";
import type { InboxLogFactory } from "./log";
import { sqliteInboxLog } from "./sqlite/sqlite-log";

export const LOGS_UNDER_TEST: { name: string; log: InboxLogFactory }[] = [
  { name: "jsonl", log: jsonlInboxLog },
  { name: "sqlite", log: sqliteInboxLog },
];
