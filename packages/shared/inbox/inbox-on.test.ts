/**
 * Whether the person turned the Plannotator Inbox on here (inbox-on.ts): the
 * record, the one-time decision for an install from before the rule (A used
 * the window, B ran it, C only agents, D never ran), and the test knob that
 * can never reach a real data dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInboxActionReport, isInboxNote } from "@plannotator/core/inbox-types";
import {
  decideExistingInstall,
  INBOX_OFF_AGENT_LINE,
  INBOX_OFF_LEAD,
  INBOX_OFF_PERSON_LINE,
  inboxOnRecord,
  inboxUseFromFiles,
  isInboxOffAnswer,
  isInboxOn,
  isScratchFolder,
  personWroteIt,
  readInboxOnRecord,
  recordInboxOff,
  storeShowsPersonUse,
  turnInboxOn,
  writeInboxOnRecord,
} from "./inbox-on";

/** No test knob and no sandbox marker: the real rule. */
const REAL: Record<string, string | undefined> = {};
const NOW = new Date("2026-11-18T09:00:00.000Z");

let dataDir: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "inbox-on-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
});

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const inbox = (...parts: string[]) => join(dataDir, "inbox", ...parts);
const line = (record: Record<string, unknown>, seq = 1) => JSON.stringify({ v: 1, seq, at: "2026-11-01T00:00:00.000Z", kind: "message", id: `m${seq}`, record });
const agentMessage = { id: "m1", author: { kind: "agent", name: "Claude Code" }, body: "Ship it?" };

describe("the record", () => {
  test("reads only a well-formed inboxOn; anything else is undecided", () => {
    expect(inboxOnRecord(JSON.stringify({ inboxOn: { on: true, at: "x", by: "command" } }))).toEqual({ on: true, at: "x", by: "command" });
    expect(inboxOnRecord(JSON.stringify({ inboxOn: { on: false, at: "x", by: "off", notes: "remove" } }))?.notes).toBe("remove");
    for (const text of [null, "", "{", "[]", JSON.stringify({ inboxOn: { on: "yes" } }), JSON.stringify({ other: 1 })]) expect(inboxOnRecord(text)).toBeNull();
  });

  test("an off record wins over the test knob and the sandbox", () => {
    recordInboxOff(dataDir, NOW);
    expect(isInboxOn(dataDir, { PLANNOTATOR_TEST_INBOX_ON: "1", PLANNOTATOR_TEST_SANDBOX: dataDir })).toBe(false);
  });

  test("turnInboxOn and recordInboxOff write state.json and nothing in config.json", () => {
    expect(turnInboxOn("command", dataDir, NOW)).toBe(true);
    expect(isInboxOn(dataDir, REAL)).toBe(true);
    expect(readInboxOnRecord(dataDir)).toEqual({ on: true, at: NOW.toISOString(), by: "command" });
    expect(recordInboxOff(dataDir, NOW)).toBe(true);
    expect(isInboxOn(dataDir, REAL)).toBe(false);
    expect(existsSync(join(dataDir, "config.json")) && readFileSync(join(dataDir, "config.json"), "utf8").includes("inboxOn")).toBe(false);
    expect(readFileSync(join(dataDir, "state.json"), "utf8")).toContain('"inboxOn"');
  });

  test("a write for another folder than this process's data dir is refused", () => {
    const other = mkdtempSync(join(tmpdir(), "inbox-on-other-"));
    expect(writeInboxOnRecord(other, { on: true, at: NOW.toISOString(), by: "command" })).toBe(false);
    expect(readInboxOnRecord(other)).toBeNull();
  });

  test("the refusal lines start with one lead a host can recognise", () => {
    expect(isInboxOffAnswer(`${INBOX_OFF_AGENT_LINE}\n`)).toBe(true);
    expect(isInboxOffAnswer(INBOX_OFF_PERSON_LINE)).toBe(true);
    expect(isInboxOffAnswer("The Plannotator Inbox did not start: port in use")).toBe(false);
    expect(INBOX_OFF_AGENT_LINE.startsWith(INBOX_OFF_LEAD)).toBe(true);
  });
});

describe("the test knob", () => {
  test("an undecided scratch folder counts as on only for a test run, and is not written", () => {
    expect(isInboxOn(dataDir, { PLANNOTATOR_TEST_SANDBOX: dataDir })).toBe(true);
    expect(isInboxOn(dataDir, { PLANNOTATOR_TEST_INBOX_ON: "1" })).toBe(true);
    expect(readInboxOnRecord(dataDir)).toBeNull();
    expect(isInboxOn(dataDir, { PLANNOTATOR_TEST_SANDBOX: dataDir, PLANNOTATOR_TEST_INBOX_ON: "0" })).toBe(false);
  });

  test("a folder outside the temp folders is never scratch", () => {
    expect(isScratchFolder(dataDir)).toBe(true);
    expect(isScratchFolder("/opt/plannotator-person/.plannotator")).toBe(false);
    expect(isScratchFolder("/Users/someone/.plannotator")).toBe(false);
  });
});

describe("an install from before the rule", () => {
  test("D, never ran here: off, written once, nothing to remove", () => {
    expect(isInboxOn(dataDir, REAL)).toBe(false);
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false, by: "update-never-ran" });
    expect(readInboxOnRecord(dataDir)?.notes).toBeUndefined();
  });

  test("C, only agents started it: off, with Plannotator's notes still to remove", () => {
    write(inbox("inbox.json"), "{}");
    write(inbox("projects", "p1", "messages.jsonl"), [line(agentMessage), line({ id: "m2", author: { kind: "person" }, set_aside: ["m1"] }, 2)].join("\n") + "\n");
    expect(decideExistingInstall(dataDir, NOW)).toEqual({ on: false, at: NOW.toISOString(), by: "update-agent-only", notes: "remove" });
  });

  test("B, the person ran plannotator inbox (its connect step wrote agents.json): on", () => {
    write(inbox("inbox.json"), "{}");
    write(inbox("agents.json"), "{}");
    expect(decideExistingInstall(dataDir, NOW)).toMatchObject({ on: true, by: "update-ran" });
  });

  const usedCases: [string, () => void][] = [
    ["the window's notification settings", () => write(join(dataDir, "config.json"), JSON.stringify({ inboxNotifications: { sound: true } }))],
    ["a Tour stamp", () => write(join(dataDir, "state.json"), JSON.stringify({ inboxTour: { skipped_at: "2026-10-01T00:00:00.000Z" } }))],
    ["a look at a thread", () => write(inbox("projects", "p1", "messages.jsonl"), line({ ...agentMessage, person_seen_seq: 4 }) + "\n")],
    ["a message the person wrote", () => write(inbox("projects", "p1", "messages.jsonl"), line({ id: "m2", author: { kind: "person" }, body: "Yes, ship it." }) + "\n")],
    ["an answered question", () => write(inbox("projects", "p1", "questions.jsonl"), line({ id: "q1", picked_at: "2026-11-01T00:00:00.000Z" }) + "\n")],
    ["a pin", () => write(inbox("pins.json"), JSON.stringify(["m1"]))],
    ["a draft", () => write(inbox("drafts", "m1.json"), "{}")],
    ["a paired phone", () => write(inbox("devices.jsonl"), "{}\n")],
    ["a store not yet returned from SQLite", () => write(inbox("inbox.db"), "x")],
  ];
  for (const [name, seed] of usedCases) {
    test(`A, the person used the window (${name}): on`, () => {
      write(inbox("inbox.json"), "{}");
      seed();
      expect(decideExistingInstall(dataDir, NOW)).toMatchObject({ on: true, by: "update-used" });
    });
  }

  test("decided once: a later look reads the record and changes nothing", () => {
    write(inbox("inbox.json"), "{}");
    const first = decideExistingInstall(dataDir, NOW);
    write(inbox("agents.json"), "{}");
    expect(decideExistingInstall(dataDir, new Date("2026-12-01T00:00:00.000Z"))).toEqual(first);
    expect(isInboxOn(dataDir, REAL)).toBe(false);
  });

  test("a person's message far into a large store, across a multi-byte boundary, is found", () => {
    const filler = line({ ...agentMessage, body: "é".repeat(400) });
    const lines = Array.from({ length: 3000 }, () => filler);
    lines.push(line({ id: "m9", author: { kind: "person" }, body: "Go." }, 9));
    write(inbox("projects", "p1", "messages.jsonl"), lines.join("\n"));
    expect(storeShowsPersonUse(inbox())).toBe(true);
  });

  test("the cheap files alone (what the Claude Code mod reads): used, ran or nothing", () => {
    expect(inboxUseFromFiles({ config: JSON.stringify({ inboxNotifications: {} }) })).toBe("used");
    expect(inboxUseFromFiles({ agentsFile: true })).toBe("ran");
    expect(inboxUseFromFiles({ config: JSON.stringify({ inboxTool: { "claude-code": true } }) })).toBe("ran");
    expect(inboxUseFromFiles({ config: "{", state: null, agentsFile: false })).toBeNull();
  });
});

// The store scan cannot import @plannotator/core (the Pi extension vendors it
// without core), so it writes out "a message the person wrote". The failure
// this guards: core gains a new kind of Inbox note stored as the person's, and
// an agent-only install is read as one the person used.
describe("personWroteIt matches core's notes and action reports", () => {
  const person = { kind: "person" };
  const samples: Record<string, unknown>[] = [
    { author: person, body: "hi" },
    { author: { kind: "agent" }, body: "hi" },
    { author: person, set_aside: ["m1"] },
    { author: person, reopened: ["m1"] },
    { author: person, ack_of: "m1" },
    { author: person, tidy: { moved: 1 } },
    { author: person, action_report: ["sent"] },
    { author: person, scheduled_run: { id: "r1" } },
    { author: person, set_aside: [] },
  ];
  for (const sample of samples) {
    test(JSON.stringify(sample), () => {
      const core = sample.author && (sample.author as { kind: string }).kind === "person" && !sample.scheduled_run && !isInboxNote(sample as never) && !isInboxActionReport(sample as never);
      expect(personWroteIt(sample)).toBe(!!core);
    });
  }
});

// Settings' Plannotator Inbox row, on every server (POST /api/config { inboxOn }).
describe("the Settings write", () => {
  test("on is the person's click (settings); off answers how to turn it back on, or the error when it did not save", async () => {
    const { inboxOnConfigWrite, INBOX_TURN_ON_AGAIN, INBOX_OFF_NOT_SAVED } = await import("./inbox-on-config");
    expect(await inboxOnConfigWrite(true, async () => true)).toEqual({ status: 200, body: { ok: true } });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true, by: "settings" });
    let offAsked = 0;
    expect(await inboxOnConfigWrite(false, async () => (offAsked++, recordInboxOff(dataDir, NOW)))).toEqual({ status: 200, body: { ok: true, inboxOnLine: INBOX_TURN_ON_AGAIN } });
    expect(offAsked).toBe(1);
    expect(isInboxOn(dataDir, REAL)).toBe(false);
    expect(await inboxOnConfigWrite(false, async () => false)).toEqual({ status: 500, body: { error: INBOX_OFF_NOT_SAVED } });
  });
});
