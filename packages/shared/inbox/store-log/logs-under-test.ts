/**
 * The record logs the store-log tests run against (`every-read.test.ts`, `budget.test.ts`). A new log joins
 * this list; the tests do not change. Test-only.
 */
import { jsonlInboxLog } from "./jsonl-log";
import type { InboxLogFactory } from "./log";
import { sqliteInboxLog } from "./sqlite/sqlite-log";

export const LOGS_UNDER_TEST: { name: string; log: InboxLogFactory }[] = [
  { name: "jsonl", log: jsonlInboxLog },
  { name: "sqlite", log: sqliteInboxLog },
];
