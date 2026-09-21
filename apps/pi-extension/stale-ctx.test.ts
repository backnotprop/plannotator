import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";

/**
 * Regression coverage for issue #1140.
 *
 * Pi invalidates a captured `ctx` (and the `pi` object it came from) when the
 * session is replaced or disposed. Every accessor then throws the message
 * below. The post-approval continuation in `agent_end` polls `ctx.isIdle()`
 * from a `setTimeout`, so a teardown mid-poll used to throw inside a timer
 * callback — uncatchable by the host, fatal to the process.
 */
const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-stale-ctx-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Pi host stub trimmed to what the plan lifecycle needs, plus a `goStale()`
 * switch that makes every guarded surface behave exactly like a torn-down
 * session: `ctx.mode`, `ctx.isIdle()` and `pi.sendUserMessage()` all throw the
 * real staleness error.
 */
function createHarness(cwd: string) {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sentUserMessages: string[] = [];
	const state = { activeTools: ["read", "bash", "edit", "write"], thinkingLevel: "medium" };
	let stale = false;
	let idle = false;

	const assertActive = (): void => {
		if (stale) throw new Error(STALE_MESSAGE);
	};

	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: () => undefined,
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
			tools.set(tool.name, tool),
		getFlag: () => true,
		getActiveTools: () => {
			assertActive();
			return [...state.activeTools];
		},
		setActiveTools: (next: string[]) => {
			assertActive();
			state.activeTools = [...next];
		},
		getThinkingLevel: () => state.thinkingLevel,
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: (content: string) => {
			assertActive();
			sentUserMessages.push(content);
		},
	};

	const ctx = {
		cwd,
		hasUI: false,
		isProjectTrusted: () => {
			assertActive();
			return true;
		},
		get mode() {
			assertActive();
			return "print";
		},
		isIdle: () => {
			assertActive();
			return idle;
		},
		model: { provider: "test", id: "original-model" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "test-session",
			getSessionFile: () => "session.json",
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	};

	return {
		sentUserMessages,
		setIdle(next: boolean) {
			idle = next;
		},
		async startSession(): Promise<void> {
			plannotator(pi as never);
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx);
			}
		},
		submitPlan(filePath: string) {
			return tools.get("plannotator_submit_plan")!.execute("call-1", { filePath }, undefined, undefined, ctx);
		},
		async agentEnd(): Promise<void> {
			for (const handler of handlers.get("agent_end") ?? []) {
				await handler({}, ctx);
			}
		},
		/** Reproduce a real teardown: shutdown event first, then invalidation. */
		async teardown({ emitShutdown = true } = {}): Promise<void> {
			if (emitShutdown) {
				for (const handler of handlers.get("session_shutdown") ?? []) {
					await handler({ type: "session_shutdown", reason: "quit" }, ctx);
				}
			}
			stale = true;
		},
	};
}

/** Fail the test on anything the host would have seen as a fatal process error. */
async function withFatalErrorTrap<T>(run: () => Promise<T>): Promise<{ result: T; fatal: unknown[] }> {
	const fatal: unknown[] = [];
	const onUncaught = (err: unknown) => fatal.push(err);
	const onUnhandled = (err: unknown) => fatal.push(err);
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUnhandled);
	try {
		const result = await run();
		// Let any pending 50ms poll tick land inside the trap.
		await sleep(300);
		return { result, fatal };
	} finally {
		process.off("uncaughtException", onUncaught);
		process.off("unhandledRejection", onUnhandled);
	}
}

const PLAN_CONTENT = "# Plan\n\n- [ ] First step\n";

async function approveAndScheduleContinuation(cwd: string) {
	writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
	const harness = createHarness(cwd);
	await harness.startSession();
	// hasUI:false auto-approves, which arms the post-approval continuation.
	await harness.submitPlan("PLAN.md");
	// The agent is still winding down, so the first poll re-arms the timer.
	harness.setIdle(false);
	await harness.agentEnd();
	return harness;
}

describe("post-approval continuation survives session teardown", () => {
	test("a session torn down mid-poll cancels the continuation instead of crashing", async () => {
		const cwd = makeTempDir();
		const { result: harness, fatal } = await withFatalErrorTrap(async () => {
			const h = await approveAndScheduleContinuation(cwd);
			await sleep(60); // at least one poll tick has run against a live ctx
			await h.teardown();
			return h;
		});

		expect(fatal).toEqual([]);
		expect(harness.sentUserMessages).toEqual([]);
	});

	test("teardown without a session_shutdown event still cancels via the ctx probe", async () => {
		const cwd = makeTempDir();
		const { result: harness, fatal } = await withFatalErrorTrap(async () => {
			const h = await approveAndScheduleContinuation(cwd);
			await sleep(60);
			await h.teardown({ emitShutdown: false });
			return h;
		});

		expect(fatal).toEqual([]);
		expect(harness.sentUserMessages).toEqual([]);
	});

	test("a live session still gets the continuation once the agent goes idle", async () => {
		const cwd = makeTempDir();
		const { result: harness, fatal } = await withFatalErrorTrap(async () => {
			const h = await approveAndScheduleContinuation(cwd);
			await sleep(60);
			h.setIdle(true);
			return h;
		});

		expect(fatal).toEqual([]);
		expect(harness.sentUserMessages).toEqual(["Continue with the approved plan."]);
	});
});
