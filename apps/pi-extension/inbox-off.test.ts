/**
 * Pi (and Oh My Pi, the same extension) offers the Inbox tool only once the person turned the Inbox on here
 * (packages/shared/inbox/inbox-on.ts): with the record off, setupPiInbox does nothing, even where an Inbox ran
 * before and its tools are remembered; with it on, it sets the tool up. No Inbox starts and nothing listens: the
 * registry is unreadable, so discovery reads only the remembered tools.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupPiInbox } from "./inbox.ts";

/** One tool the Inbox serves, as a remembered list holds it. */
const TOOLS = [{ name: "send_message", description: "Send.", inputSchema: { type: "object", properties: { body: { type: "string" } } } }];

let dataDir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	dataDir = join(mkdtempSync(join(tmpdir(), "plannotator-pi-inbox-off-")), "data");
	mkdirSync(join(dataDir, "inbox"), { recursive: true });
	writeFileSync(join(dataDir, "inbox", "inbox.json"), "not a registry");
	writeFileSync(join(dataDir, "inbox", "connection-tools.json"), JSON.stringify({ tools: TOOLS }));
	for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_TEST_INBOX_ON"]) saved[key] = process.env[key];
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_INBOX_TOOL = "1";
	process.env.PLANNOTATOR_TEST_INBOX_ON = "0";
});
afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const record = (on: boolean) => writeFileSync(join(dataDir, "state.json"), JSON.stringify({ inboxOn: { on, at: "2026-11-18T09:00:00.000Z", by: on ? "command" : "off" } }));

test("off: no tool and nothing looked up; on: the tool is set up", async () => {
	const registered: string[] = [];
	// A Pi that accepts every call the extension makes and remembers the tools it registers.
	const pi = new Proxy({} as Record<string, unknown>, {
		get: (_target, key) => (key === "registerTool" ? (tool: { name: string }) => void registered.push(tool.name) : () => undefined),
	}) as never;
	record(false);
	expect(setupPiInbox(pi, { isAskActive: () => false })).toBeUndefined();
	expect(registered).toEqual([]);
	record(true);
	await setupPiInbox(pi, { isAskActive: () => false });
	expect(registered.length).toBeGreaterThan(0);
});
