/**
 * Turning the Inbox off and settling an install from before the rule
 * (inbox-on-settle.ts), in a scratch home (tests/helpers/fake-agents.ts): the
 * record says off before anything else, Plannotator's untouched notes go, a
 * note the person edited stays, and the decision runs once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { readInboxOnRecord, turnInboxOn } from "@plannotator/shared/inbox/inbox-on";
import { addInboxNote, INBOX_NOTE_BLOCK } from "./inbox-agent-notes";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { INBOX_TURN_ON_AGAIN, inboxOffReport, settleInboxOn, turnInboxOff } from "./inbox-on-settle";

/** The real rule: no test knob, no sandbox marker. */
const REAL: Record<string, string | undefined> = {};

let fake: FakeAgents;
let dataDir: string;
let e: AgentEnvironment;
let saved: string | undefined;

beforeEach(() => {
  fake = createFakeAgents("plannotator-inbox-on-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  e = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env });
});
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
  fake.remove();
});

const claudeNote = () => join(fake.home, ".claude", "rules", "plannotator-inbox.md");
const geminiNote = () => join(fake.home, ".gemini", "GEMINI.md");
const editGemini = () => {
  mkdirSync(join(fake.home, ".gemini"), { recursive: true });
  writeFileSync(geminiNote(), `# Mine\n\n${INBOX_NOTE_BLOCK.replace("\n## Plannotator Inbox", "\n- a fact of mine\n## Plannotator Inbox")}\n`);
};

describe("turn the Inbox off", () => {
  test("records off, removes Plannotator's untouched note, keeps the edited one, and says how to turn it back on", async () => {
    turnInboxOn("command", dataDir);
    expect(addInboxNote("claude-code", dataDir, e)).toMatchObject({ ok: true });
    editGemini();

    const off = await turnInboxOff(dataDir, { environment: e });

    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false, by: "off" });
    expect(readInboxOnRecord(dataDir)?.notes).toBeUndefined();
    expect(existsSync(claudeNote())).toBe(false);
    expect(readFileSync(geminiNote(), "utf8")).toContain("a fact of mine");
    expect(off.notes.removed.map((n) => n.agent)).toEqual(["claude-code"]);
    expect(off.notes.kept.map((n) => n.agent)).toEqual(["gemini"]);
    const report = inboxOffReport(off);
    expect(report[0]).toBe("The Plannotator Inbox is off on this computer: agents lose it from their next session, and nothing starts it.");
    expect(report.at(-1)).toBe(INBOX_TURN_ON_AGAIN);
    expect(report.some((line) => line.startsWith("Left the note for Gemini CLI") && line.endsWith(": you edited it."))).toBe(true);
  });

  // H1: the routines' start at login would bring the Inbox back at the next login.
  test("removes the routines' start at login and says it comes back with routines", async () => {
    turnInboxOn("command", dataDir);
    const unit = join(fake.home, ".config", "systemd", "user", "plannotator-inbox.service");
    mkdirSync(join(unit, ".."), { recursive: true });
    writeFileSync(unit, "[Service]\n");
    const off = await turnInboxOff(dataDir, { environment: e });
    expect(existsSync(unit)).toBe(false);
    expect(inboxOffReport(off)).toContain("Removed the Inbox's start at login; it comes back with routines when you turn the Inbox on.");
  });

  test("off twice is the same as once", async () => {
    await turnInboxOff(dataDir, { environment: e });
    const again = await turnInboxOff(dataDir, { environment: e });
    expect(again.recorded).toBe(true);
    expect(again.notes).toEqual({ removed: [], kept: [], failed: [] });
  });
});

describe("an install from before the rule, settled once", () => {
  test("C, only agents started it: decided off and Plannotator's untouched notes removed; the edited one stays", () => {
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "inbox.json"), "{}");
    expect(addInboxNote("claude-code", dataDir, e)).toMatchObject({ ok: true });
    editGemini();

    expect(settleInboxOn(dataDir, { environment: e, env: REAL })).toBe(false);
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false, by: "update-agent-only" });
    expect(readInboxOnRecord(dataDir)?.notes).toBeUndefined();
    expect(existsSync(claudeNote())).toBe(false);
    expect(readFileSync(geminiNote(), "utf8")).toContain("a fact of mine");
  });

  // M3: each file on its own (Codex reads AGENTS.override.md first; the person edited the note in AGENTS.md).
  test("C with a Codex note in two files: the untouched one goes (the file keeps its other text), the edited one stays", () => {
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "inbox.json"), "{}");
    const codex = join(fake.home, ".codex");
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(codex, "AGENTS.override.md"), `# Mine\n\n${INBOX_NOTE_BLOCK}\n`);
    const edited = `# Rules\n\n${INBOX_NOTE_BLOCK.replace("\n## Plannotator Inbox", "\n- my own line\n## Plannotator Inbox")}\n`;
    writeFileSync(join(codex, "AGENTS.md"), edited);

    expect(settleInboxOn(dataDir, { environment: e, env: REAL })).toBe(false);
    expect(readFileSync(join(codex, "AGENTS.override.md"), "utf8")).toBe("# Mine\n");
    expect(readFileSync(join(codex, "AGENTS.md"), "utf8")).toBe(edited);
  });

  // M7: a note that cannot go (damaged markers) is tried once, recorded as left, and never retried by itself.
  test("C with a damaged note: tried once, the record says left, the next settle touches nothing", () => {
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "inbox.json"), "{}");
    mkdirSync(join(fake.home, ".gemini"), { recursive: true });
    const damaged = `# Mine\n\n${INBOX_NOTE_BLOCK.split("\n").slice(0, -1).join("\n")}\n`;
    writeFileSync(geminiNote(), damaged);

    expect(settleInboxOn(dataDir, { environment: e, env: REAL })).toBe(false);
    const record = readInboxOnRecord(dataDir);
    expect(record).toMatchObject({ on: false, by: "update-agent-only", notes: "left" });
    expect(settleInboxOn(dataDir, { environment: e, env: REAL })).toBe(false);
    expect(readInboxOnRecord(dataDir)).toEqual(record);
    expect(readFileSync(geminiNote(), "utf8")).toBe(damaged);
  });

  test("B, the person ran it: stays on and no note is touched", () => {
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "agents.json"), "{}");
    expect(addInboxNote("claude-code", dataDir, e)).toMatchObject({ ok: true });

    expect(settleInboxOn(dataDir, { environment: e, env: REAL })).toBe(true);
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true, by: "update-ran" });
    expect(existsSync(claudeNote())).toBe(true);
  });

  test("D, never ran: off, nothing to remove, nothing written", () => {
    expect(settleInboxOn(dataDir, { environment: e, env: REAL })).toBe(false);
    expect(readInboxOnRecord(dataDir)).toBeNull();
    expect(existsSync(join(dataDir, "inbox"))).toBe(false);
  });

  test("decided on by the person later: settle leaves it on", () => {
    settleInboxOn(dataDir, { environment: e, env: REAL });
    turnInboxOn("command", dataDir);
    expect(settleInboxOn(dataDir, { environment: e, env: REAL })).toBe(true);
  });
});
