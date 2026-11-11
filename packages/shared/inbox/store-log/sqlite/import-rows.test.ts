/** The import's fast writer leaves exactly the rows the live writer leaves for the same lines; ids the writers make up are compared by what they stand for. */
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
