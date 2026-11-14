/**
 * The record logs the store-log tests run against (`every-read.test.ts`, `budget.test.ts`). Test-only.
 */
import { jsonlInboxLog } from "./jsonl-log";
import type { InboxLogFactory } from "./log";

export const LOGS_UNDER_TEST: { name: string; log: InboxLogFactory }[] = [
  { name: "jsonl", log: jsonlInboxLog },
];
