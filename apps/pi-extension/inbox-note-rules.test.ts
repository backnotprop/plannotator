/**
 * Pi's Inbox reminder and the person's rules in the Inbox's note: the failure
 * this guards is Pi getting the rules twice (its instructions file and the
 * reminder) or not at all. A scratch Pi folder only; no Inbox, no Pi.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxNoteBlockWith } from "../../packages/server/inbox-agent-notes";
import { INBOX_RULES_LEAD, inboxReminderText } from "../../packages/shared/inbox/connection";
import { piInboxReminder } from "./inbox.ts";

const RULES = "Ask me before you delete any file.";
// The Inbox tool on for Pi (the reminder goes only with it).
const config = { inboxTool: true, prompts: { inbox: { rules: RULES } } };
let root: string;
let place: { env: Record<string, string>; homeDir: string };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "plannotator-pi-note-rules-"));
	place = { env: { PI_CODING_AGENT_DIR: join(root, "agent") }, homeDir: join(root, "home") };
	mkdirSync(join(root, "agent"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("no note: the reminder carries the rules, as before", () => {
	expect(piInboxReminder(config, {}, place)).toBe(`${inboxReminderText()}\n\n${INBOX_RULES_LEAD}\n${RULES}`);
});

test("Pi's instructions file holds the note with the rules: the reminder is today's line", () => {
	writeFileSync(join(root, "agent", "AGENTS.md"), `Mine.\n\n${inboxNoteBlockWith(RULES)}\n`);
	expect(piInboxReminder(config, {}, place)).toBe(inboxReminderText());
	// Pi reads the first file that exists: a note in a file Pi does not read holds nothing.
	writeFileSync(join(root, "agent", "AGENTS.override.md"), "Override.\n");
	expect(piInboxReminder(config, {}, place)?.endsWith(RULES)).toBe(true);
});

test("the reminder switched off: none, rules or not", () => {
	expect(piInboxReminder({ ...config, inboxReminder: false }, {}, place)).toBeNull();
});
