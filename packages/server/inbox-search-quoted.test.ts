/**
 * The Search tip's "already searched with quotes" read (inbox-search.ts `recentSearchesQuotedReader`), asked on every
 * settings read while the tip is not stamped: forever for someone who searched with quotes (never shown it) and for an
 * Inbox whose data folder cannot be written. What regresses: the recent searches read and parsed again on every
 * settings read though the file did not change; a change to the file (a new search kept, Clear) not read again; no
 * file throwing. No Inbox started: a temp folder only.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_RECENT_SEARCHES_FILE, readRecentSearches, recentSearchesQuotedReader } from "./inbox-search";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** As the Inbox keeps them: a new file renamed in. */
function keep(dir: string, searches: string[]): void {
  const temp = join(dir, `${INBOX_RECENT_SEARCHES_FILE}.tmp`);
  writeFileSync(temp, `${JSON.stringify({ v: 1, searches })}\n`);
  renameSync(temp, join(dir, INBOX_RECENT_SEARCHES_FILE));
}

test("the recent searches are read once while the file stays the same, and again when it changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-search-quoted-"));
  roots.push(dir);
  let reads = 0;
  const quoted = recentSearchesQuotedReader(dir, (at) => {
    reads += 1;
    return readRecentSearches(at);
  });
  // No file yet: none quoted, nothing parsed, nothing thrown.
  expect(quoted()).toBe(false);
  expect(reads).toBe(0);
  keep(dir, ['"upload checksums"', "csv export"]);
  for (let i = 0; i < 5; i++) expect(quoted()).toBe(true);
  expect(reads).toBe(1);
  // Clear (or a new search kept): read again.
  keep(dir, []);
  expect(quoted()).toBe(false);
  expect(quoted()).toBe(false);
  expect(reads).toBe(2);
});
