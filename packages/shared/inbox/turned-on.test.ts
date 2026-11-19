// The one gate of the Inbox (turned-on.ts): off until the person's own `plannotator inbox` writes the mark, and on
// wherever an Inbox already ran. The failures this guards: an agent's start counting as the person's, a computer
// where the Inbox already ran (a person reading threads in the window, or an older plannotator's start) going dark
// after the update, a mark read half-written, or a test switch that reaches a real data dir.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxTurnedOnPath, isInboxTurnedOn, markInboxTurnedOn, testRunCountsOn } from "./turned-on";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scratch data dir; `ran`: an Inbox ran here before the mark existed (`inbox/inbox.json`). */
function dataDir(ran = false): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-turned-on-"));
  roots.push(root);
  mkdirSync(join(root, "inbox"), { recursive: true });
  if (ran) writeFileSync(join(root, "inbox", "inbox.json"), JSON.stringify({ pid: 1, port: 1, token: "t", version: "0.29.0" }));
  return root;
}

/** The real rule: no test knob, no sandbox marker. */
const REAL = {};
const mark = (dir: string) => JSON.parse(readFileSync(inboxTurnedOnPath(dir), "utf8")) as { on: boolean; by: string };

describe("the mark", () => {
  test("a computer where the Inbox never ran is off, and reading it writes nothing", () => {
    const dir = dataDir();
    expect(isInboxTurnedOn(dir, REAL)).toBe(false);
    expect(readdirSync(join(dir, "inbox"))).toEqual([]);
  });

  test("the person's run turns it on, written whole (no temp file left)", () => {
    const dir = dataDir();
    expect(markInboxTurnedOn(dir)).toBe(true);
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
    expect(readdirSync(join(dir, "inbox"))).toEqual(["turned-on"]);
    expect(mark(dir)).toMatchObject({ on: true, by: "command" });
  });

  test("a mark that cannot be parsed, or is empty, keeps it on", () => {
    const dir = dataDir();
    writeFileSync(inboxTurnedOnPath(dir), "");
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
    writeFileSync(inboxTurnedOnPath(dir), "garbled");
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
  });
});

describe("a computer where an Inbox already ran (inbox/inbox.json, no mark)", () => {
  test("a window user who only read threads and picked answers (inbox.json and projects/*, nothing else): on, written once", () => {
    const dir = dataDir(true);
    mkdirSync(join(dir, "inbox", "projects", "p1"), { recursive: true });
    writeFileSync(join(dir, "inbox", "projects", "p1", "questions.jsonl"), '{"picked_at":"2026-11-01T00:00:00Z"}\n');
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
    expect(mark(dir)).toMatchObject({ on: true, by: "update-existing" });
    expect(readdirSync(join(dir, "inbox")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("an older plannotator started the person's Inbox on a fresh computer (it writes no mark): on", () => {
    const dir = dataDir(true);
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
  });

  test("an inbox.json that is not a file it can see: on for the read, and no mark written", () => {
    const dir = dataDir();
    mkdirSync(join(dir, "inbox", "inbox.json"));
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
    expect(readdirSync(join(dir, "inbox"))).toEqual(["inbox.json"]);
  });

  test("the first writer's mark stands: a reader never replaces it", () => {
    const dir = dataDir(true);
    markInboxTurnedOn(dir);
    const first = readFileSync(inboxTurnedOnPath(dir), "utf8");
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
    expect(readFileSync(inboxTurnedOnPath(dir), "utf8")).toBe(first);
  });
});

describe("the test switch", () => {
  test("the knob counts a data dir with no mark as on; the sandbox only a scratch one; =0 gives the real rule", () => {
    const dir = dataDir();
    expect(isInboxTurnedOn(dir, { PLANNOTATOR_TEST_INBOX_ON: "1" })).toBe(true);
    expect(isInboxTurnedOn(dir, { PLANNOTATOR_TEST_SANDBOX: dir })).toBe(true);
    expect(isInboxTurnedOn(dir, { PLANNOTATOR_TEST_SANDBOX: dir, PLANNOTATOR_TEST_INBOX_ON: "0" })).toBe(false);
    // A person's real data dir (outside the temp folder) under a stray sandbox marker: the real rule.
    expect(testRunCountsOn("/Users/someone/.plannotator", { PLANNOTATOR_TEST_SANDBOX: "/tmp/x" })).toBe(false);
  });
});
