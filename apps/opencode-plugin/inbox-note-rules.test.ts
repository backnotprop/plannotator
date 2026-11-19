/**
 * OpenCode's Inbox reminder and the person's rules in the Inbox's note
 * (`~/.config/opencode/AGENTS.md`). OpenCode builds its system prompt for each
 * request and reads AGENTS.md then, so the reminder asks on each request too.
 * The failures this guards: the rules twice (file and reminder) after the note
 * got them while OpenCode ran, or none after the note was turned off. A
 * scratch config folder only; no Inbox, no OpenCode.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxConfigWatch, inboxReminderRulesWatch, type PlannotatorConfig } from "@plannotator/shared/config";
import { INBOX_RULES_LEAD, inboxReminderText } from "@plannotator/shared/inbox/connection";
import { inboxNoteBlockWith } from "../../packages/server/inbox-agent-notes";
import { openCode2InboxReminder } from "./server";

const RULES = "Ask me before you delete any file.";
const config = { prompts: { inbox: { rules: RULES } } };
let root: string;
let agents: string;
let place: { env: Record<string, string>; homeDir: string };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-opencode-note-rules-"));
  mkdirSync(join(root, "opencode"), { recursive: true });
  agents = join(root, "opencode", "AGENTS.md");
  place = { env: { OPENCODE_CONFIG_DIR: join(root, "opencode") }, homeDir: join(root, "home") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeAt = (text: string, seconds: number) => {
  writeFileSync(agents, text);
  utimesSync(agents, seconds, seconds);
};

test("each request: the rules go while AGENTS.md lacks them and stop once the note holds them, and back", () => {
  const rulesNow = inboxReminderRulesWatch(config, "opencode", place);
  const wakes = { session: { prompt: () => {} } };
  expect(openCode2InboxReminder(wakes, config, rulesNow())).toBe(`${inboxReminderText(undefined, { wakes: true })}\n\n${INBOX_RULES_LEAD}\n${RULES}`);
  writeAt(`Mine.\n\n${inboxNoteBlockWith(RULES)}\n`, 1_000);
  expect(openCode2InboxReminder(wakes, config, rulesNow())).toBe(inboxReminderText(undefined, { wakes: true }));
  // The same bytes on the next request (the cached prefix does not move).
  expect(openCode2InboxReminder(wakes, config, rulesNow())).toBe(inboxReminderText(undefined, { wakes: true }));
  // The note turned off: the file changes, the reminder carries them again.
  writeAt("Mine.\n", 2_000);
  expect(rulesNow()).toBe(RULES);
});

test("no rules: nothing is looked at, the reminder is today's", () => {
  expect(inboxReminderRulesWatch({}, "opencode", place)()).toBeNull();
  expect(openCode2InboxReminder({}, {}, null)).toBe(inboxReminderText(undefined, { wakes: false }));
});

test("rules saved while OpenCode runs: the note is compared with the new rules, so R2 arrives once and R1 never again", () => {
  const R2 = "Only message me when you are blocked.";
  const configPath = join(root, "config.json");
  const saveRules = (rules: string, seconds: number) => {
    writeFileSync(configPath, JSON.stringify({ prompts: { inbox: { rules } } }));
    utimesSync(configPath, seconds, seconds);
  };
  saveRules(RULES, 1_000);
  writeAt(`Mine.\n\n${inboxNoteBlockWith(RULES)}\n`, 1_000);
  const read = () => JSON.parse(readFileSync(configPath, "utf8")) as PlannotatorConfig;
  const rulesNow = inboxReminderRulesWatch(inboxConfigWatch(read(), configPath, read), "opencode", place);
  expect(rulesNow()).toBeNull();
  // Saved; the note still holds R1 (not rewritten yet): R2 goes in the reminder.
  saveRules(R2, 2_000);
  expect(rulesNow()).toBe(R2);
  // The Inbox rewrote the note with R2: none in the reminder, on every later request.
  writeAt(`Mine.\n\n${inboxNoteBlockWith(R2)}\n`, 2_000);
  expect(rulesNow()).toBeNull();
  expect(rulesNow()).toBeNull();
});

test("config.json unreadable for a moment (a save half done): the last good rules stay, and the next good save is read", () => {
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  utimesSync(configPath, 1_000, 1_000);
  let next: PlannotatorConfig | null = null;
  const configNow = inboxConfigWatch(config, configPath, () => next);
  writeFileSync(configPath, "{");
  utimesSync(configPath, 2_000, 2_000);
  expect(configNow()).toBe(config);
  next = { prompts: { inbox: { rules: "Later." } } };
  expect(configNow()).toBe(next);
});
