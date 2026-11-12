/// <reference types="bun-types" />
/**
 * `plannotator inbox export --jsonl <folder>` (design brief "The Inbox on SQLite", section 5: export, no lock-in):
 * the person's Inbox as today's JSONL files, from whichever record keeps it now. With `inbox.db` (the SQLite
 * switch moved it), the database written back line by line (`export.ts`); without it, the JSONL files copied as
 * they are. Either way the folder reads like `<data dir>/inbox`: `projects/<key>/*.jsonl`, `initiatives.jsonl`,
 * `seq.json`. Only reads the Inbox: a running one keeps running, and nothing in it changes.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "../../schema";
import { exportInboxDb } from "./export";
import { JSONL_ENTRIES } from "./move-files";
import { INBOX_DB_FILE } from "./sqlite-log";

export type InboxExportResult = { from: "database" | "files"; lines: number } | { from: "empty"; lines: 0 };

export class InboxExportError extends Error {
  constructor(
    readonly code: "not_empty",
    message: string,
  ) {
    super(message);
  }
}

/** Export the Inbox under `dataDir` into `outDir`, which must not exist yet or be empty. */
export function exportInbox(dataDir: string, outDir: string): InboxExportResult {
  if (existsSync(outDir) && (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0)) {
    throw new InboxExportError("not_empty", `${outDir} is not an empty folder. Name a new or empty one.`);
  }
  const inbox = inboxDir(dataDir);
  const db = join(inbox, INBOX_DB_FILE);
  if (existsSync(db)) return { from: "database", ...exportInboxDb(db, outDir) };
  const present = JSONL_ENTRIES.filter((entry) => existsSync(join(inbox, entry)));
  if (present.length === 0) return { from: "empty", lines: 0 };
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  for (const entry of present) cpSync(join(inbox, entry), join(outDir, entry), { recursive: true });
  return { from: "files", lines: linesUnder(join(outDir, JSONL_ENTRIES[0]!)) + linesIn(join(outDir, JSONL_ENTRIES[1]!)) };
}

function linesIn(file: string): number {
  if (!existsSync(file)) return 0;
  let count = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) if (line.trim()) count++;
  return count;
}

function linesUnder(path: string): number {
  if (!existsSync(path)) return 0;
  if (!statSync(path).isDirectory()) return path.endsWith(".jsonl") ? linesIn(path) : 0;
  return readdirSync(path).reduce((sum, child) => sum + linesUnder(join(path, child)), 0);
}
