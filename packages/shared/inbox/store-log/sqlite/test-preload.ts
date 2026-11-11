/**
 * Test-only: makes SQLite the store's default log.
 *   bun test --preload ./packages/shared/inbox/store-log/sqlite/test-preload.ts packages/shared/inbox/store.test.ts
 */
import { mock } from "bun:test";
import { sqliteInboxLog } from "./sqlite-log";

mock.module(new URL("../jsonl-log.ts", import.meta.url).pathname, () => ({ jsonlInboxLog: sqliteInboxLog }));
