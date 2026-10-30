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
import { INBOX_COMMAND_BRIEFING } from "./generated/inbox/connection.ts";

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

/** What the command sent the session: Pi's `sendMessage` calls, message and options. */
const sent: Array<[unknown, unknown]> = [];

/** The extension's `message_start` handlers: Pi's agent loop runs them for each message the next prompt carries. */
const messageStart: Array<(event: unknown) => unknown> = [];

/** A Pi session with the extension loaded; `run` runs /plannotator-inbox in it. */
function piSession() {
	sent.length = 0;
	messageStart.length = 0;
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown) => unknown) => {
			if (event === "message_start") messageStart.push(handler);
		},
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
		sendMessage: (message: unknown, options: unknown) => void sent.push([message, options]),
		sendUserMessage: () => undefined,
	};
	plannotator(pi as never);
	const notices: Array<{ message: string; type: string }> = [];
	const ctx = { ui: { notify: (message: string, type: string) => notices.push({ message, type }) } };
	return {
		notices,
		run: () => commands.get("plannotator-inbox")!.handler("", ctx),
		/** The person's next prompt starts: Pi emits `message_start` for each pending message it carries (others' handlers may need more than this stand-in has). */
		nextPrompt: async () => {
			for (const [message] of sent.splice(0)) {
				for (const handler of messageStart) {
					try {
						await handler({ type: "message_start", message: { role: "custom", ...(message as object) } });
					} catch {}
				}
			}
		},
	};
}

async function runInboxCommand(): Promise<Array<{ message: string; type: string }>> {
	const session = piSession();
	await session.run();
	return session.notices;
}

describe.skipIf(process.platform === "win32")("/plannotator-inbox", () => {
	test("opens the Inbox through plannotator inbox --open and shows its address", async () => {
		const { calls } = fakePlannotator("echo 'http://localhost:61234/'");
		const notices = await runInboxCommand();
		expect(readFileSync(calls, "utf8").trim()).toBe(`inbox --open | ${process.env.PLANNOTATOR_DATA_DIR}`);
		expect(notices).toHaveLength(1);
		expect(notices[0]!.type).toBe("info");
		expect(notices[0]!.message).toContain("http://localhost:61234/");
		// The model gets the Inbox briefing hidden, with the next prompt: no turn of its own.
		expect(sent).toEqual([
			[{ customType: "plannotator-inbox-briefing", content: INBOX_COMMAND_BRIEFING, display: false }, { deliverAs: "nextTurn" }],
		]);
	});

	// Failure caught: the briefing queued once per run, so the next prompt carries two copies.
	test("run twice before the next prompt, the briefing waits once; after that prompt, it is queued again", async () => {
		fakePlannotator("echo 'http://localhost:61234/'");
		const session = piSession();
		await session.run();
		await session.run();
		expect(session.notices).toHaveLength(2);
		expect(sent).toHaveLength(1);
		await session.nextPrompt();
		await session.run();
		expect(sent).toHaveLength(1);
	});

	test("an older plannotator without --open is told to update", async () => {
		fakePlannotator("echo 'Unknown inbox option: --open' >&2; exit 1");
		const notices = await runInboxCommand();
		expect(notices).toHaveLength(1);
		expect(notices[0]!.type).toBe("error");
		expect(notices[0]!.message).toContain("plannotator update");
		expect(sent).toEqual([]);
	});
});
