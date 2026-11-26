/**
 * The last patch of each PR no list names, kept on disk for a page open on it (inbox-pull-last-diff.ts). In process,
 * in a temp folder: no CLI, no forge, no Inbox.
 *
 * What regresses:
 *  - more than `INBOX_PULL_LAST_DIFFS_SAVED_MAX` patches on disk, or the oldest kept instead of the newest;
 *  - the byte bound counting UTF-16 units, so non-ASCII patches write past it;
 *  - one patch over the bound keeping every other patch off disk;
 *  - the same patch read again rewriting the whole file (its time alone changed);
 *  - the patch of a PR the person hid written to disk;
 *  - a corrupt file throwing, or keeping the store from writing again.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxPullDiffAnswer } from "@plannotator/core/inbox-types";
import { createLastDiffs, INBOX_PULL_LAST_DIFFS_SAVED_BYTES, INBOX_PULL_LAST_DIFFS_SAVED_MAX, lastDiffId } from "./inbox-pull-last-diff";

const keyOf = (n: number) => `github.com/northwind/billing-svc#${n}`;
const answerOf = (n: number, patch = `diff --git a/a.ts b/a.ts\n+${n}\n`): InboxPullDiffAnswer => ({ key: keyOf(n), scope: "layer", base: "main", head: `branch-${n}`, patch, description: null, head_sha: null, state: "merged", merged_at: null });
const idOf = (n: number) => lastDiffId(keyOf(n), "layer", "main");

function withFolder(run: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-last-diffs-"));
  try {
    run(join(dir, "pull-last-diffs.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** The PR numbers on disk, in the file's order (newest first). */
const onDisk = (file: string): number[] => (JSON.parse(readFileSync(file, "utf8")) as { diffs: { answer: { key: string } }[] }).diffs.map((d) => Number(d.answer.key.split("#")[1]));

test("at most the newest INBOX_PULL_LAST_DIFFS_SAVED_MAX patches go to disk, newest first", () => {
  withFolder((file) => {
    let now = 1_000;
    const diffs = createLastDiffs({ now: () => now, file });
    for (let n = 1; n <= INBOX_PULL_LAST_DIFFS_SAVED_MAX + 3; n += 1) {
      now += 1;
      diffs.put(idOf(n), answerOf(n));
    }
    diffs.save(() => true);
    const want = Array.from({ length: INBOX_PULL_LAST_DIFFS_SAVED_MAX }, (_, i) => INBOX_PULL_LAST_DIFFS_SAVED_MAX + 3 - i);
    expect(onDisk(file)).toEqual(want);
  });
});

test("the byte bound counts the bytes written: non-ASCII patches under it in UTF-16 units still stop at it", () => {
  withFolder((file) => {
    let now = 1_000;
    const diffs = createLastDiffs({ now: () => now, file });
    // "€" is one UTF-16 unit and three bytes: each patch is 0.3 of the bound in units, 0.9 in bytes.
    const units = Math.floor((INBOX_PULL_LAST_DIFFS_SAVED_BYTES * 0.3));
    for (const n of [1, 2]) {
      now += 1;
      diffs.put(idOf(n), answerOf(n, "€".repeat(units)));
    }
    diffs.save(() => true);
    expect(onDisk(file)).toEqual([2]);
    expect(statSync(file).size).toBeLessThanOrEqual(INBOX_PULL_LAST_DIFFS_SAVED_BYTES + 1024);
  });
});

test("one patch over the bound is left out; the others still go to disk", () => {
  withFolder((file) => {
    let now = 1_000;
    const diffs = createLastDiffs({ now: () => now, file });
    for (const n of [1, 2]) {
      now += 1;
      diffs.put(idOf(n), answerOf(n));
    }
    now += 1;
    diffs.put(idOf(3), answerOf(3, "x".repeat(INBOX_PULL_LAST_DIFFS_SAVED_BYTES + 1)));
    diffs.save(() => true);
    expect(onDisk(file)).toEqual([2, 1]);
  });
});

test("the same patch read again later does not rewrite the file; a changed one does", () => {
  withFolder((file) => {
    let now = 1_000;
    const diffs = createLastDiffs({ now: () => now, file });
    diffs.put(idOf(1), answerOf(1));
    diffs.put(idOf(2), answerOf(2));
    diffs.save(() => true);
    const before = readFileSync(file, "utf8");
    // Read again a minute later, word for word the same (a new answer object): nothing new to keep.
    now += 60_000;
    diffs.put(idOf(1), answerOf(1));
    diffs.save(() => true);
    expect(readFileSync(file, "utf8")).toBe(before);
    // A new commit on it: written.
    diffs.put(idOf(1), answerOf(1, "diff --git a/a.ts b/a.ts\n+moved\n"));
    diffs.save(() => true);
    expect(readFileSync(file, "utf8")).not.toBe(before);
    expect(createLastDiffs({ now: () => now, file }).get(idOf(1))?.answer.patch).toContain("+moved");
  });
});

test("the patch of a PR the person hid never goes to disk", () => {
  withFolder((file) => {
    const hid = new Set<string>();
    const diffs = createLastDiffs({ now: () => 1_000, file, hidden: (key) => hid.has(key) });
    diffs.put(idOf(1), answerOf(1));
    diffs.put(idOf(2), answerOf(2));
    hid.add(keyOf(2));
    diffs.save(() => true);
    expect(onDisk(file)).toEqual([1]);
  });
});

test("a corrupt file keeps nothing and does not stop the next write", () => {
  withFolder((file) => {
    writeFileSync(file, '{"v":1,"diffs":[{"id":');
    const diffs = createLastDiffs({ now: () => 1_000, file });
    expect(diffs.get(idOf(1))).toBeUndefined();
    diffs.put(idOf(1), answerOf(1));
    diffs.save(() => true);
    expect(onDisk(file)).toEqual([1]);
    expect(createLastDiffs({ now: () => 2_000, file }).get(idOf(1))?.answer.patch).toBe(answerOf(1).patch);
  });
});
