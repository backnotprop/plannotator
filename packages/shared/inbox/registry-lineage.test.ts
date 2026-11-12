import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_SESSION_LINEAGE_MAX, inboxHome, inboxSessionLineage } from "./registry";

const made: string[] = [];
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-lineage-"));
  made.push(dir);
  mkdirSync(join(dir, "inbox"));
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a restart in the same folder follows the last run, then the runs that one followed, newest first", () => {
  const home = inboxHome(dataDir())!;
  expect(inboxSessionLineage({ serverSession: "b", follows: ["a"], home }, home)).toEqual(["b", "a"]);
  expect(inboxSessionLineage({ serverSession: "a", home }, home)).toEqual(["a"]);
});

test("the line is capped: a window that slept through more restarts reloads, as before", () => {
  const home = inboxHome(dataDir())!;
  const follows = Array.from({ length: 20 }, (_, i) => `run-${i}`);
  const line = inboxSessionLineage({ serverSession: "last", follows, home }, home);
  expect(line.length).toBe(INBOX_SESSION_LINEAGE_MAX);
  expect(line[0]).toBe("last");
});

test("no last entry, one an older Inbox wrote (no folder named), or an unreadable folder: no line", () => {
  const home = inboxHome(dataDir())!;
  expect(inboxSessionLineage(null, home)).toEqual([]);
  expect(inboxSessionLineage({ serverSession: "a" }, home)).toEqual([]);
  expect(inboxSessionLineage({ serverSession: "a", home }, null)).toEqual([]);
  expect(inboxHome(join(tmpdir(), "plannotator-lineage-none"))).toBeNull();
});

test("a copy of the folder, also one put back at the same path, is another folder: no line", () => {
  const dir = dataDir();
  const home = inboxHome(dir)!;
  const entry = { serverSession: "a", home };
  const copy = dataDir();
  rmSync(join(copy, "inbox"), { recursive: true });
  cpSync(join(dir, "inbox"), join(copy, "inbox"), { recursive: true });
  expect(inboxSessionLineage(entry, inboxHome(copy))).toEqual([]);
  cpSync(join(dir, "inbox"), join(dir, "inbox.copy"), { recursive: true });
  rmSync(join(dir, "inbox"), { recursive: true });
  renameSync(join(dir, "inbox.copy"), join(dir, "inbox"));
  expect(inboxSessionLineage(entry, inboxHome(dir))).toEqual([]);
  const moved = dataDir();
  rmSync(join(moved, "inbox"), { recursive: true });
  const kept = inboxHome(dir)!;
  renameSync(join(dir, "inbox"), join(moved, "inbox"));
  expect(inboxSessionLineage({ serverSession: "a", home: kept }, inboxHome(moved))).toEqual(["a"]);
});
