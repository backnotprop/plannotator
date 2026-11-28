/**
 * Pi's Inbox reminder and the person's rules in the Inbox's note: the failure
 * this guards is Pi getting the rules twice (its instructions file and the
 * reminder) or not at all. A scratch Pi folder only; no Inbox, no Pi.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxNoteBlockWith } from "../../packages/server/inbox-agent-notes.ts";
import { INBOX_RULES_LEAD, inboxReminderText } from "../../packages/shared/inbox/connection.ts";
import { piInboxReminder, piReminderFollower } from "./inbox.ts";

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
	expect(piInboxReminder(config, { env: {}, place })).toBe(`${inboxReminderText()}\n\n${INBOX_RULES_LEAD}\n${RULES}`);
});

test("Pi's instructions file holds the note with the rules: the reminder is today's line", () => {
	writeFileSync(join(root, "agent", "AGENTS.md"), `Mine.\n\n${inboxNoteBlockWith(RULES)}\n`);
	expect(piInboxReminder(config, { env: {}, place })).toBe(inboxReminderText());
	// Pi reads the first file that exists: a note in a file Pi does not read holds nothing.
	writeFileSync(join(root, "agent", "AGENTS.override.md"), "Override.\n");
	expect(piInboxReminder(config, { env: {}, place })?.endsWith(RULES)).toBe(true);
});

test("the reminder switched off: none, rules or not", () => {
	expect(piInboxReminder({ ...config, inboxReminder: false }, { env: {}, place })).toBeNull();
});

test("Oh My Pi: Pi's note holds the rules, but OMP reads its own folder, so its reminder carries them", () => {
	writeFileSync(join(root, "agent", "AGENTS.md"), `Mine.\n\n${inboxNoteBlockWith(RULES)}\n`);
	expect(piInboxReminder(config, { env: {}, place })).toBe(inboxReminderText());
	expect(piInboxReminder(config, { host: "oh-my-pi", env: {}, place })).toBe(`${inboxReminderText()}\n\n${INBOX_RULES_LEAD}\n${RULES}`);
	expect(piInboxReminder({ ...config, inboxReminder: false }, { host: "oh-my-pi", env: {}, place })).toBeNull();
});

/** A stand-in for the ExtensionAPI's `on`, with a way to raise an event. */
function fakeOn() {
	const handlers = new Map<string, ((event: unknown) => unknown)[]>();
	return {
		on: (event: string, handler: (event: unknown) => unknown) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		emit: (event: string) => (handlers.get(event) ?? []).forEach((handler) => handler({})),
	};
}

test("Oh My Pi: a session it switches to gets a reminder decided then, never the one decided for the session before", () => {
	const pi = fakeOn();
	let now: string | null = "R2";
	const reminder = piReminderFollower(pi, "oh-my-pi", "R1", () => now);
	expect(reminder()).toBe("R1");
	pi.emit("session_switch");
	expect(reminder()).toBe("R2");
	now = null;
	pi.emit("session_switch");
	expect(reminder()).toBeNull();
	// A decision that throws (config.json unreadable for a moment) keeps the last one.
	now = "R3";
	pi.emit("session_switch");
	const failing = piReminderFollower(pi, "oh-my-pi", "R1", () => {
		throw new Error("unreadable");
	});
	pi.emit("session_switch");
	expect(failing()).toBe("R1");
	expect(reminder()).toBe("R3");
});

test("Pi: one session per instance, so its setup-time reminder stands", () => {
	const pi = fakeOn();
	const reminder = piReminderFollower(pi, "pi", "R1", () => "R2");
	pi.emit("session_switch");
	expect(reminder()).toBe("R1");
});
