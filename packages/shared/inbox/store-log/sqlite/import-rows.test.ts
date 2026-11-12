/**
 * The import's fast writer (`import-rows.ts` + `import-load.ts`) leaves exactly the tables the live writer
 * (`write-line.ts`) leaves after writing the same lines one by one: every row of every table, and the schema with
 * its indexes rebuilt. Ids the writers make up (actors' and answers') are compared by what they stand for.
 *
 * The failure this guards: the two writers drifting apart, so that an imported Inbox holds rows a live one never
 * would (and the next live write, which reads them back, goes wrong), even while the store happens to read the
 * same today. The import's own check guards what the store serves; this guards the rows under it.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLine } from "@plannotator/core/inbox-types";
import { jsonlInboxLog } from "../jsonl-log";
import { writeInboxWorld } from "../world";
import { oldShapeLines } from "./fixtures/old-shapes";
import { loadImportRows } from "./import-load";
import { ImportRows } from "./import-rows";
import { openInboxDb } from "./sqlite-log";
import { tablesOf } from "./tables-of";
import { writeLine } from "./write-line";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-import-rows-"));
  roots.push(dir);
  return dir;
};

/** The same lines through each writer; both databases' tables. */
function bothWays(lines: InboxLine[]) {
  const dir = temp();
  const sorted = [...lines].sort((a, b) => a.seq - b.seq);
  const live = openInboxDb(dir, "live.db");
  for (const line of sorted) live.db.transaction((tx) => writeLine(tx, line));
  live.sqlite.close();
  const rows = new ImportRows();
  for (const line of sorted) rows.add(line);
  const bulk = openInboxDb(dir, "bulk.db");
  loadImportRows(bulk.sqlite, rows);
  bulk.sqlite.close();
  return { live: tablesOf(join(dir, "live.db")), bulk: tablesOf(join(dir, "bulk.db")) };
}

test(
  "generated Inboxes: the fast writer leaves the live writer's rows, table for table",
  () => {
    for (const seed of [31, 32, 33]) {
      const dataDir = temp();
      writeInboxWorld({ dataDir, seed, steps: 260 });
      const lines = jsonlInboxLog(join(dataDir, "inbox")).read().lines!;
      // Each line twice over (a retried append), and the seeds' typing merged both ways.
      const { live, bulk } = bothWays([...lines, ...lines.filter((_, i) => i % 7 === 0)]);
      expect(bulk).toEqual(live);
    }
  },
  300_000,
);

test("old record shapes: the fast writer leaves the live writer's rows", () => {
  const { live, bulk } = bothWays(oldShapeLines());
  expect(bulk).toEqual(live);
});
