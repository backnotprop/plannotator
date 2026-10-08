/**
 * Plannotator Snapshots on Pi (snapshots.ts) against a REAL Snapshots hub in
 * this process (tests/helpers/snapshots-hub.ts), over a fake Pi that behaves
 * like Pi for the calls the link makes: `sendUserMessage` starts a user
 * message, `sendMessage(..., { triggerTurn })` runs a turn that streams an
 * answer. The person is played through the hub's HUD routes.
 *
 * What regresses if this fails:
 *  - `/plannotator-snapshot` stops summoning with this session (`--session pi:<id>`)
 *    or blocks until the send;
 *  - a Send stops arriving in the session, arrives twice, or as anything but
 *    a followUp user message with the hub's composed text;
 *  - Ask from the HUD stops being a turn of this session;
 *  - the switch off stops leaving Pi untouched (no command, no hub link).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestSnapshotsHub, tempSnapshotsDataDir, type TestSnapshotsHub } from "../../tests/helpers/snapshots-hub.ts";
import { createPiSessionBridgeHub } from "./pi-session-bridge.ts";
import { PI_SNAPSHOTS_COMMAND, setupPiSnapshots } from "./snapshots.ts";

const SESSION_ID = "pi-snapshots-session";
const cleanups: Array<() => void> = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(async () => {
	while (cleanups.length > 0) cleanups.pop()!();
	if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
	else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

async function world(): Promise<{ hub: TestSnapshotsHub; dataDir: string }> {
	const dataDir = tempSnapshotsDataDir();
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	const hub = await startTestSnapshotsHub(dataDir);
	cleanups.push(() => {
		hub.stop();
		rmSync(dataDir, { recursive: true, force: true });
	});
	return { hub, dataDir };
}

/** A `plannotator` stand-in: records its arguments and answers like `plannotator snapshot --session`. */
function stubPlannotator(): { bin: string; calls: () => string[] } {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-snapshots-bin-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "calls.log");
	const bin = join(dir, "plannotator");
	writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\necho "Plannotator Snapshots is open: drag a box around what you mean, mark it, and press ⌘↩. The snapshots arrive in this session as a message."\n`);
	chmodSync(bin, 0o755);
	return {
		bin,
		calls: () => {
			try {
				return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
			} catch {
				return [];
			}
		},
	};
}

function createPi() {
	const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const userMessages: Array<{ text: string; options: unknown }> = [];
	const askMessages: Array<{ content: string }> = [];
	const notices: Array<{ message: string; type: string }> = [];
	const emit = (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionFile: () => null,
			getSessionName: () => undefined,
		},
		ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
	};
	const pi = {
		on: (event: string, handler: (event: any, ctx?: any) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		// Pi starts the user message (at once when idle; after the run for a followUp otherwise).
		sendUserMessage: (text: string, options: unknown) => {
			userMessages.push({ text, options });
			queueMicrotask(() => emit("message_start", { message: { role: "user", content: text } }));
		},
		// A triggering custom message: Pi runs a turn that answers it.
		sendMessage: (message: { content: string; details: { askId: string } }) => {
			askMessages.push({ content: message.content });
			setTimeout(() => {
				emit("message_start", { message: { role: "custom", customType: "plannotator-ask", details: message.details } });
				emit("message_start", { message: { role: "assistant" } });
				emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "That is the Save button." } });
				emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
			}, 10);
		},
	};
	return { pi, ctx, handlers, commands, userMessages, askMessages, notices, emit };
}

function setup(fake: ReturnType<typeof createPi>, env: NodeJS.ProcessEnv) {
	const bridges = createPiSessionBridgeHub(fake.pi as never);
	const on = setupPiSnapshots(fake.pi as never, {
		createBridge: (ctx, origin) => bridges.createBridge(ctx, origin),
		platform: "darwin",
		env,
		retryMs: 50,
	});
	cleanups.push(() => fake.emit("session_shutdown"));
	return on;
}

describe("Plannotator Snapshots on Pi", () => {
	test("/plannotator-snapshot summons for this session and returns; the Send arrives once as a followUp with the hub's text", async () => {
		const { hub } = await world();
		const stub = stubPlannotator();
		const fake = createPi();
		expect(setup(fake, { ...process.env, PLANNOTATOR_BIN: stub.bin })).toBe(true);
		fake.emit("session_start", { reason: "startup" });

		await fake.commands.get(PI_SNAPSHOTS_COMMAND)!.handler("--app", fake.ctx);
		expect(stub.calls()).toEqual([`snapshot --session pi:${SESSION_ID} --app`]);
		expect(fake.notices.at(-1)?.message).toStartWith("Plannotator Snapshots is open");
		expect(fake.userMessages).toHaveLength(0);

		// What the real `plannotator snapshot --session` does on the hub.
		await hub.summon("pi", SESSION_ID);
		await hub.waitForState((state) => state.connections.some((c: { host: string; sessionId: string }) => c.host === "pi" && c.sessionId === SESSION_ID));
		const { collectionId } = await hub.capture();
		const sent = await hub.send(collectionId);
		await hub.waitForState((state) => state.lastSent?.send?.state === "delivered");
		// Past a re-send: still one message.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(fake.userMessages).toEqual([{ text: sent.text, options: { deliverAs: "followUp" } }]);
	});

	test("Ask from the HUD is a real turn of this Pi session", async () => {
		const { hub } = await world();
		const fake = createPi();
		setup(fake, process.env);
		fake.emit("session_start", { reason: "startup" });
		await hub.waitForState((state) => state.connections.some((c: { sessionId: string; canAsk: boolean }) => c.sessionId === SESSION_ID && c.canAsk));
		const answer = await hub.ask("What is this button?", { host: "pi", sessionId: SESSION_ID });
		expect(answer.text).toBe("That is the Save button.");
		expect(fake.askMessages).toHaveLength(1);
		expect(fake.askMessages[0]!.content).toContain("What is this button?");
		expect(fake.askMessages[0]!.content).toContain("Plannotator Snapshots");
	});

	test("the person typing in this session is what routes a hotkey-started collection here", async () => {
		const { hub } = await world();
		const fake = createPi();
		setup(fake, process.env);
		fake.emit("session_start", { reason: "startup" });
		fake.emit("input", { text: "fix the header layout", source: "interactive" });
		const state = await hub.waitForState((current) =>
			current.connections.some((c: { sessionId: string; lastHumanInputAt: number }) => c.sessionId === SESSION_ID && c.lastHumanInputAt > 0),
		);
		expect(state.connections.find((c: { sessionId: string }) => c.sessionId === SESSION_ID).title).toBe("fix the header layout");
	});

	test("switched off: no command, and the session never links to the hub", async () => {
		const { hub } = await world();
		const fake = createPi();
		expect(setup(fake, { ...process.env, PLANNOTATOR_SNAPSHOTS: "0" })).toBe(false);
		fake.emit("session_start", { reason: "startup" });
		expect(fake.commands.has(PI_SNAPSHOTS_COMMAND)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await hub.state()).connections).toEqual([]);
	});

	test("off macOS the command explains and points at snapshot add, without running plannotator", async () => {
		await world();
		const stub = stubPlannotator();
		const fake = createPi();
		const bridges = createPiSessionBridgeHub(fake.pi as never);
		setupPiSnapshots(fake.pi as never, { createBridge: (ctx, origin) => bridges.createBridge(ctx, origin), platform: "linux", env: { ...process.env, PLANNOTATOR_BIN: stub.bin }, retryMs: 50 });
		cleanups.push(() => fake.emit("session_shutdown"));
		await fake.commands.get(PI_SNAPSHOTS_COMMAND)!.handler("", fake.ctx);
		expect(stub.calls()).toEqual([]);
		expect(fake.notices.at(-1)?.message).toContain("plannotator snapshot add");
	});
});
