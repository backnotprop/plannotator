/**
 * Test-only preload: the store's default record log becomes the SQLite one, so the existing store tests run
 * against it unchanged, one file at a time:
 *
 *   bun test --preload ./packages/shared/inbox/store-log/sqlite/test-preload.ts packages/shared/inbox/store.test.ts
 *
 * Every `InboxStore.open` without a `log` (all of them, outside the store-log tests) then keeps its records in
 * `inbox.db`. A test that reads or writes the JSONL files themselves fails under it by design; one that reads the
 * store's answers and fails is a defect in the SQLite log.
 */
import { mock } from "bun:test";
import { sqliteInboxLog } from "./sqlite-log";

mock.module(new URL("../jsonl-log.ts", import.meta.url).pathname, () => ({ jsonlInboxLog: sqliteInboxLog }));
