// The one gate of the Inbox (turned-on.ts): off until the person's own `plannotator inbox` writes the mark, and an
// install from before the mark decided once from cheap files. The failures this guards: an agent's start counting
// as the person's, a used install going quiet after the update, an agent-only one getting the tool and the
// reminder, or a file that cannot be read turning the Inbox off.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxPersonUsedIt } from "./connection";
import { inboxTurnedOnPath, isInboxTurnedOn, markInboxTurnedOn } from "./turned-on";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, "inbox"), 0o700);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

/** A scratch data dir; `ran`: an Inbox ran here before the mark existed (`inbox/inbox.json`). */
function dataDir(ran = false): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-turned-on-"));
  roots.push(root);
  mkdirSync(join(root, "inbox"), { recursive: true });
  if (ran) writeFileSync(join(root, "inbox", "inbox.json"), JSON.stringify({ pid: 1, port: 1, token: "t" }));
  return root;
}

/** The real rule: no test knob, no sandbox marker. */
const REAL = {};
const mark = (dir: string) => JSON.parse(readFileSync(inboxTurnedOnPath(dir), "utf8")) as { on: boolean; by: string };

describe("the mark", () => {
  test("a fresh computer is off, and reading it writes nothing", () => {
    const dir = dataDir();
    expect(isInboxTurnedOn(dir, REAL)).toBe(false);
    expect(() => readFileSync(inboxTurnedOnPath(dir))).toThrow();
  });

  test("the person's run turns it on, and an agent-only mark says off", () => {
    const dir = dataDir();
    expect(markInboxTurnedOn(dir)).toBe(true);
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
    writeFileSync(inboxTurnedOnPath(dir), '{"on":false,"by":"update-agent-only"}');
    expect(isInboxTurnedOn(dir, REAL)).toBe(false);
    // Only "on": false reads off: a mark that is not JSON keeps it on.
    writeFileSync(inboxTurnedOnPath(dir), "garbled");
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
  });

  test("the test knob counts a scratch dir with no mark as on; =0 gives the real rule", () => {
    const dir = dataDir();
    expect(isInboxTurnedOn(dir, { PLANNOTATOR_TEST_INBOX_ON: "1" })).toBe(true);
    expect(isInboxTurnedOn(dir, { PLANNOTATOR_TEST_SANDBOX: dir })).toBe(true);
    expect(isInboxTurnedOn(dir, { PLANNOTATOR_TEST_SANDBOX: dir, PLANNOTATOR_TEST_INBOX_ON: "0" })).toBe(false);
  });
});

describe("an install from before the mark, decided once", () => {
  test("only agents ever started it: off, written, and later agent files do not turn it on", () => {
    const dir = dataDir(true);
    writeFileSync(join(dir, "inbox", "inbox.log"), "started\n");
    expect(isInboxTurnedOn(dir, REAL)).toBe(false);
    expect(mark(dir)).toMatchObject({ on: false, by: "update-agent-only" });
    writeFileSync(join(dir, "inbox", "agents.json"), "{}");
    expect(isInboxTurnedOn(dir, REAL)).toBe(false);
  });

  test("a person used it: on, written", () => {
    const used: [string, string][] = [
      ["inbox/agents.json", "{}"],
      ["inbox/inbox.db", "SQLite format 3"],
      ["inbox/devices.jsonl", '{"id":"d"}\n'],
      ["inbox/pins.json", '["thr_1"]'],
      ["inbox/snoozes.json", '{"thr_1":"2026-11-20"}'],
      ["inbox/reply-drafts/thr_1.json", '{"thread_id":"thr_1"}'],
      ["config.json", '{"inboxNotifications":{"enabled":true}}'],
      ["config.json", '{"inboxTool":{"pi":true}}'],
      ["config.json", '{"inboxScheduledThreads":true}'],
      ["state.json", '{"inboxTour":{"skipped_at":"2026-11-01T00:00:00Z"}}'],
    ];
    for (const [file, text] of used) {
      const dir = dataDir(true);
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), text);
      expect([file, text, isInboxTurnedOn(dir, REAL)]).toEqual([file, text, true]);
      expect(mark(dir)).toMatchObject({ on: true, by: "update-used" });
    }
  });

  test("empty files and settings that are not the person's do not count", () => {
    const dir = dataDir(true);
    writeFileSync(join(dir, "inbox", "pins.json"), "[]");
    writeFileSync(join(dir, "inbox", "inbox.db"), "");
    writeFileSync(join(dir, "config.json"), '{"inboxTool":{"pi":false},"inboxLaunch":{"enabled":false}}');
    expect(isInboxTurnedOn(dir, REAL)).toBe(false);
  });

  test("a file it cannot read counts as use: on", () => {
    expect(inboxPersonUsedIt({ config: "{", state: null, inbox: {} })).toBe(true);
    expect(inboxPersonUsedIt({ config: null, state: null, inbox: { "pins.json": null } })).toBe(true);
    const dir = dataDir(true);
    mkdirSync(join(dir, "config.json"));
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
  });

  test("the first reader's mark stands", () => {
    const dir = dataDir(true);
    expect(isInboxTurnedOn(dir, REAL)).toBe(false);
    // A person file appearing later does not re-decide.
    writeFileSync(join(dir, "inbox", "pins.json"), '["thr_1"]');
    expect(isInboxTurnedOn(dir, REAL)).toBe(false);
    // The person's own run does.
    markInboxTurnedOn(dir);
    expect(isInboxTurnedOn(dir, REAL)).toBe(true);
  });
});
