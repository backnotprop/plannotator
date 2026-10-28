/**
 * `/plannotator-inbox` on Pi: it runs `plannotator inbox --open` (a stand-in
 * script here, through PLANNOTATOR_BIN, so no Inbox starts and no browser
 * opens) with this session's data dir, and shows the address it printed. An
 * older plannotator without `--open` is told to update.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";

const ENV_KEYS = ["PLANNOTATOR_BIN", "PLANNOTATOR_DATA_DIR"] as const;
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

beforeEach(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key]!;
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `plannotator` that records its argv and data dir, then answers with `body`. */
function fakePlannotator(body: string): { calls: string } {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-inbox-command-"));
	dirs.push(dir);
	const calls = join(dir, "calls");
	const bin = join(dir, "plannotator");
	writeFileSync(bin, `#!/bin/sh\necho "$* | $PLANNOTATOR_DATA_DIR" >> '${calls}'\n${body}\n`);
	chmodSync(bin, 0o755);
	process.env.PLANNOTATOR_BIN = bin;
	process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
	return { calls };
}

async function runInboxCommand(): Promise<Array<{ message: string; type: string }>> {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: () => undefined,
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: () => undefined,
		getFlag: () => false,
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
	};
	plannotator(pi as never);
	const notices: Array<{ message: string; type: string }> = [];
	const ctx = { ui: { notify: (message: string, type: string) => notices.push({ message, type }) } };
	await commands.get("plannotator-inbox")!.handler("", ctx);
	return notices;
}

describe.skipIf(process.platform === "win32")("/plannotator-inbox", () => {
	test("opens the Inbox through plannotator inbox --open and shows its address", async () => {
		const { calls } = fakePlannotator("echo 'http://localhost:61234/'");
		const notices = await runInboxCommand();
		expect(readFileSync(calls, "utf8").trim()).toBe(`inbox --open | ${process.env.PLANNOTATOR_DATA_DIR}`);
		expect(notices).toHaveLength(1);
		expect(notices[0]!.type).toBe("info");
		expect(notices[0]!.message).toContain("http://localhost:61234/");
	});

	test("an older plannotator without --open is told to update", async () => {
		fakePlannotator("echo 'Unknown inbox option: --open' >&2; exit 1");
		const notices = await runInboxCommand();
		expect(notices).toHaveLength(1);
		expect(notices[0]!.type).toBe("error");
		expect(notices[0]!.message).toContain("plannotator update");
	});
});
