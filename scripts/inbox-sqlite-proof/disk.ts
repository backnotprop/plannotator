/**
 * What the SQLite proof (`run.ts`) reads straight off disk, from source, never through the binary: generated JSONL
 * Inboxes, every record file byte for byte wherever it sits (in place or in a dated backup), whether a database is
 * whole, and one SHA-256 of everything a store serves (the move's own check, `store-log/sqlite/check.ts`).
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InboxLine, InboxProject } from "../../packages/core/inbox-types";
import { jsonlInboxLog } from "../../packages/shared/inbox/store-log/jsonl-log";
import { digestOf } from "../../packages/shared/inbox/store-log/sqlite/check";
import { jsonlEntriesPresent } from "../../packages/shared/inbox/store-log/sqlite/move-files";
import { INBOX_DB_FILE, sqliteInboxLog } from "../../packages/shared/inbox/store-log/sqlite/sqlite-log";
import { writeInboxWorld } from "../../packages/shared/inbox/store-log/world";
import { check } from "./harness";

/** The clock every digest reads at (snoozes and waits depend on it): fixed, so two sides agree. */
export const DIGEST_NOW = () => new Date("2026-11-11T12:00:00.000Z");

/** A JSONL Inbox of about `messages` messages under `dataDir` (the store's own generated world; copies past 4,000). */
export function writeJsonlInbox(dataDir: string, messages: number, seed = 11): void {
  if (messages <= 4_000) {
    writeInboxWorld({ dataDir, seed, steps: Number.POSITIVE_INFINITY, messages, growOnly: true });
    return;
  }
  // Large: one generated world, its lines copied with fresh ids and seqs (the store's size-budget method).
  const seedDir = `${dataDir}.seed`;
  writeInboxWorld({ dataDir: seedDir, seed, steps: Number.POSITIVE_INFINITY, messages: 4_000, growOnly: true });
  const seedLines = jsonlInboxLog(join(seedDir, "inbox")).read().lines ?? [];
  const perCopy = seedLines.filter((line) => line.kind === "message").length;
  const target = jsonlInboxLog(join(dataDir, "inbox"));
  const projects = new Map<string, InboxProject>();
  for (const line of copiedLines(seedLines, Math.ceil(messages / perCopy))) {
    if (line.kind === "project") {
      if (!projects.has(line.id)) target.createProject(line.record, line);
      else target.append(line, line.record);
      projects.set(line.id, line.record);
      continue;
    }
    target.append(line, line.kind === "initiative" ? null : (projects.get((line.record as { project_id: string }).project_id) ?? null));
  }
}

const ID = /\b((?:msg|crd|stp|att|ann)_[0-9A-HJKMNP-TV-Z]{26})\b/g;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function copiedLines(lines: InboxLine[], copies: number): InboxLine[] {
  const top = Math.max(...lines.map((line) => line.seq));
  const out: InboxLine[] = lines.filter((line) => line.kind === "project" || line.kind === "initiative");
  const rest = lines.filter((line) => line.kind !== "project" && line.kind !== "initiative");
  for (let c = 0; c < copies; c++) {
    const tag = B32[1 + (c >> 5)]! + B32[c & 31]!;
    for (const line of rest) {
      const text = c === 0 ? JSON.stringify(line) : JSON.stringify(line).replace(ID, (id) => `${id.slice(0, 4)}${tag}${id.slice(6)}`);
      out.push({ ...(JSON.parse(text) as InboxLine), seq: line.seq + c * top });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Every record file, by its path under its entry, wherever it is (in place or in a JSONL backup). Fails on a file found twice. */
export function recordFiles(inbox: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string, name: string) => {
    if (statSync(path).isDirectory()) for (const child of readdirSync(path)) walk(join(path, child), `${name}/${child}`);
    else {
      check(out[name] === undefined, `record file ${name} found twice`);
      out[name] = readFileSync(path, "latin1");
    }
  };
  const homes = [inbox, ...readdirSync(inbox).filter((n) => /^backup-.*-jsonl/.test(n)).map((n) => join(inbox, n))];
  for (const home of homes) for (const entry of jsonlEntriesPresent(home)) walk(join(home, entry), entry);
  return out;
}

export function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a).sort();
  return keys.join("\n") === Object.keys(b).sort().join("\n") && keys.every((key) => a[key] === b[key]);
}

/** An `inbox.db` is there only complete and whole. */
export function noHalfDatabase(inbox: string): void {
  const file = join(inbox, INBOX_DB_FILE);
  if (!existsSync(file)) return;
  const db = new Database(file, { readwrite: true, create: false, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const imported = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'import_complete'").get()?.value;
    const fresh = db.query<{ n: number }, []>("SELECT count(*) AS n FROM meta WHERE key = 'import_backup'").get()?.n === 0;
    check(imported || fresh, "inbox.db is in place without its complete mark");
    check(db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check === "ok", "inbox.db fails integrity_check");
  } finally {
    db.close();
  }
}

/** What the files in place serve, as one SHA-256. */
export function filesDigest(dataDir: string): string {
  return digestOf(dataDir, DIGEST_NOW, { log: jsonlInboxLog }).sha256;
}

/** What `inbox.db` serves, as one SHA-256. */
export function databaseDigest(dataDir: string): string {
  return digestOf(dataDir, DIGEST_NOW, { log: (dir) => sqliteInboxLog(dir) }).sha256;
}

/** What a folder in the layout of `inbox/` (an export) serves. */
export function folderDigest(dataDir: string, folder: string): string {
  return digestOf(dataDir, DIGEST_NOW, { log: () => jsonlInboxLog(folder) }).sha256;
}

export function copyInbox(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
}
