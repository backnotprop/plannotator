import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";

type Handler = (event: unknown, context: ReturnType<typeof createContext>) => unknown;

type SessionEntry = { type: string; customType?: string; data?: unknown };

type PromptResult =
	| {
			systemPrompt?: string;
			message?: { customType: string; content: string; display: boolean; details?: { phase?: string } };
	  }
	| undefined;

type ContextMessage = {
	role?: string;
	customType?: string;
	content?: unknown;
	details?: { phase?: string };
};

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

afterEach(() => {
	restoreEnv("HOME", originalHome);
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * Isolates config lookup so only the extension's shipped plannotator.json (plus
 * an optional project config) is loaded — never the developer's own global one.
 */
function makeWorkspace(projectConfig?: unknown): string {
	const home = makeTempDir("plannotator-prompt-home-");
	const cwd = makeTempDir("plannotator-prompt-cwd-");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

	if (projectConfig !== undefined) {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "plannotator.json"), JSON.stringify(projectConfig), "utf-8");
	}

	return cwd;
}

function createContext(options: { cwd?: string; entries?: SessionEntry[]; projectTrusted?: boolean } = {}) {
	const entries = options.entries ?? [];
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	return {
		cwd: options.cwd ?? process.cwd(),
		hasUI: false,
		isProjectTrusted: () => options.projectTrusted ?? true,
		isIdle: () => true,
		model: undefined,
		modelRegistry: { find: () => undefined },
		notifications,
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
			getSessionFile: () => undefined,
			getSessionId: () => "test-session",
			getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string, level?: string) => {
				notifications.push({ message, level });
			},
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: {
				bold: (text: string) => text,
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
	};
}

function createRuntime(initialTools: string[] = ["read", "bash", "edit", "write"]) {
	const commands = new Map<string, { handler: (args: string, context: ReturnType<typeof createContext>) => unknown }>();
	const handlers = new Map<string, Handler[]>();
	const persisted: Array<Record<string, unknown>> = [];

	let activeTools = [...initialTools];

	const pi = {
		appendEntry: (_type: string, data: Record<string, unknown>) => {
			persisted.push(data);
		},
		events: { on: () => () => undefined },
		getActiveTools: () => [...activeTools],
		getFlag: () => false,
		getThinkingLevel: () => "medium",
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: { handler: (args: string, context: ReturnType<typeof createContext>) => unknown }) => {
			commands.set(name, command);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerTool: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: (tools: string[]) => {
			activeTools = [...tools];
		},
		setModel: async () => true,
		setThinkingLevel: () => undefined,
	};

	plannotator(pi as never);

	return {
		commands,
		lastPersistedState: () => persisted.at(-1),
		run: async (event: string, context: ReturnType<typeof createContext>, payload: unknown = {}) => {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, context));
			return results;
		},
	};
}

async function startAgent(
	runtime: ReturnType<typeof createRuntime>,
	context: ReturnType<typeof createContext>,
): Promise<PromptResult> {
	const results = await runtime.run("before_agent_start", context, {});
	return results[0] as PromptResult;
}

async function filterContext(
	runtime: ReturnType<typeof createRuntime>,
	context: ReturnType<typeof createContext>,
	messages: ContextMessage[],
): Promise<ContextMessage[] | undefined> {
	const results = await runtime.run("context", context, { messages });
	const result = results[0] as { messages?: ContextMessage[] } | undefined;
	return result?.messages;
}

function executingContext(
	cwd: string,
	options: { framingDelivered?: boolean } = {},
): ReturnType<typeof createContext> {
	return createContext({
		cwd,
		entries: [
			{
				type: "custom",
				customType: "plannotator",
				data: {
					phase: "executing",
					lastSubmittedPath: "PLAN.md",
					savedState: { thinkingLevel: "medium" },
					...(options.framingDelivered !== undefined ? { framingDelivered: options.framingDelivered } : {}),
				},
			},
		],
	});
}

function templateWarnings(context: ReturnType<typeof createContext>): Array<{ message: string; level: string | undefined }> {
	return context.notifications.filter((n) => n.level === "warning" && n.message.includes("unknown template variables"));
}

const framingMessage = (phase: string, content = `framing-${phase}`): ContextMessage => ({
	role: "custom",
	customType: "plannotator-framing",
	content,
	details: { phase },
});

const todoMessage = (content = "todo"): ContextMessage => ({
	role: "custom",
	customType: "plannotator-context",
	content,
});

describe("Plannotator phase framing messages", () => {
	test("before_agent_start never returns a systemPrompt in any phase", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n- [ ] Step two\n", "utf-8");
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		const results: PromptResult[] = [];
		results.push(await startAgent(runtime, context)); // idle
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		results.push(await startAgent(runtime, context)); // planning entry
		results.push(await startAgent(runtime, context)); // mid-planning
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context); // back to idle

		const executing = executingContext(cwd);
		const executingRuntime = createRuntime();
		await executingRuntime.run("session_start", executing);
		results.push(await startAgent(executingRuntime, executing)); // executing entry
		results.push(await startAgent(executingRuntime, executing)); // mid-executing

		for (const result of results) {
			expect(result === undefined || !("systemPrompt" in result)).toBe(true);
		}
	});

	test("idle prompts inject nothing", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		expect(await startAgent(runtime, context)).toBeUndefined();
	});

	test("planning framing is delivered exactly once per phase entry", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		const first = await startAgent(runtime, context);
		expect(first?.message?.customType).toBe("plannotator-framing");
		expect(first?.message?.display).toBe(false);
		expect(first?.message?.details).toEqual({ phase: "planning" });
		expect(first?.message?.content).toContain("[PLANNOTATOR - PLANNING PHASE]");
		expect(templateWarnings(context)).toEqual([]);

		// Later prompts in the same planning cycle (including deny/resubmit
		// rounds, which never leave the planning phase) inject nothing: the
		// framing already sits in conversation history.
		expect(await startAgent(runtime, context)).toBeUndefined();
		expect(await startAgent(runtime, context)).toBeUndefined();
	});

	test("re-entering planning delivers fresh framing for the new cycle", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect((await startAgent(runtime, context))?.message?.customType).toBe("plannotator-framing");
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context); // exit to idle
		expect(await startAgent(runtime, context)).toBeUndefined();

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context); // re-enter
		const reentry = await startAgent(runtime, context);
		expect(reentry?.message?.customType).toBe("plannotator-framing");
		expect(reentry?.message?.content).toContain("[PLANNOTATOR - PLANNING PHASE]");
	});

	test("executing delivers framing with an entry todo snapshot, then per-turn todo status", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n- [ ] Step two\n", "utf-8");
		const runtime = createRuntime();
		const context = executingContext(cwd);
		await runtime.run("session_start", context);

		const first = await startAgent(runtime, context);
		expect(first?.message?.customType).toBe("plannotator-framing");
		expect(first?.message?.details).toEqual({ phase: "executing" });
		expect(first?.message?.content).toContain("planning phase is over");
		expect(first?.message?.content).toContain("PLAN.md");
		// Entry snapshot via ${todoList} in the shipped instructions.
		expect(first?.message?.content).toContain("- [ ] 1. Step one");

		const second = await startAgent(runtime, context);
		expect(second?.message?.customType).toBe("plannotator-context");
		expect(second?.message?.content).toContain("0/2 steps complete");
		expect(second?.message?.content).toContain("- [ ] 1. Step one");
		// The completion-marker convention rides every todo message so the
		// protocol survives between a compaction and the framing re-delivery.
		expect(second?.message?.content).toContain("[DONE:n]");
		expect(second?.message?.content).not.toContain("planning phase is over");

		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [x] Step one\n- [ ] Step two\n", "utf-8");
		const third = await startAgent(runtime, context);
		expect(third?.message?.customType).toBe("plannotator-context");
		expect(third?.message?.content).toContain("1/2 steps complete");
		expect(third?.message?.content).not.toContain("Step one");
		expect(third?.message?.content).toContain("- [ ] 2. Step two");
		expect(third?.message?.content).not.toBe(second?.message?.content);
	});

	test("a resumed session with delivered framing does not re-deliver it", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n", "utf-8");
		const runtime = createRuntime();
		const context = executingContext(cwd, { framingDelivered: true });
		await runtime.run("session_start", context);

		const first = await startAgent(runtime, context);
		expect(first?.message?.customType).toBe("plannotator-context");
		expect(first?.message?.content).toContain("0/1 steps complete");
	});

	test("custom instructions without ${todoList} get the todo snapshot appended once", async () => {
		const cwd = makeWorkspace({
			phases: { executing: { instructions: "CUSTOM EXECUTION for ${planFilePath}" } },
		});
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n", "utf-8");
		const runtime = createRuntime();
		const context = executingContext(cwd);
		await runtime.run("session_start", context);

		const first = await startAgent(runtime, context);
		expect(first?.message?.customType).toBe("plannotator-framing");
		expect(first?.message?.content?.startsWith("CUSTOM EXECUTION for PLAN.md")).toBe(true);
		expect(first?.message?.content).toContain("0/1 steps complete");
		expect(first?.message?.content).toContain("- [ ] 1. Step one");
		expect(templateWarnings(context)).toEqual([]);

		const second = await startAgent(runtime, context);
		expect(second?.message?.customType).toBe("plannotator-context");
	});

	test("null instructions disable framing but keep the todo status", async () => {
		const cwd = makeWorkspace({
			phases: { executing: { instructions: null } },
		});
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n", "utf-8");
		const runtime = createRuntime();
		const context = executingContext(cwd);
		await runtime.run("session_start", context);

		const first = await startAgent(runtime, context);
		expect(first?.message?.customType).toBe("plannotator-context");
		expect(first?.message?.content).toContain("0/1 steps complete");
		expect(first?.message?.content).not.toContain("planning phase is over");
	});

	test("unknown template variables warn while known ones render", async () => {
		const cwd = makeWorkspace({
			phases: { planning: { instructions: "Plan at ${planFilePath} ${bogus}" } },
		});
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		const result = await startAgent(runtime, context);
		expect(result?.message?.content).toContain("Plan at your plan file");
		const warnings = templateWarnings(context);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("bogus");
	});

	test("ignores project Plannotator config when Pi denies project trust", async () => {
		const cwd = makeWorkspace({
			phases: { planning: { instructions: "untrusted-project-instructions" } },
		});
		const runtime = createRuntime();
		const context = createContext({ cwd, projectTrusted: false });
		await runtime.run("session_start", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		const result = await startAgent(runtime, context);
		expect(result?.message?.content).toContain("[PLANNOTATOR - PLANNING PHASE]");
		expect(result?.message?.content).not.toContain("untrusted-project-instructions");
	});

	test("fails closed with an update warning when an older Pi host lacks project trust", async () => {
		const cwd = makeWorkspace({
			phases: { planning: { instructions: "untrusted-project-instructions" } },
		});
		const globalConfigDir = process.env.PI_CODING_AGENT_DIR!;
		mkdirSync(globalConfigDir, { recursive: true });
		writeFileSync(
			join(globalConfigDir, "plannotator.json"),
			JSON.stringify({ phases: { planning: { instructions: "trusted-global-instructions" } } }),
			"utf-8",
		);
		const runtime = createRuntime();
		const context = createContext({ cwd });
		delete (context as { isProjectTrusted?: () => boolean }).isProjectTrusted;

		await runtime.run("session_start", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		const result = await startAgent(runtime, context);
		expect(result?.message?.content).toContain("trusted-global-instructions");
		expect(result?.message?.content).not.toContain("untrusted-project-instructions");
		expect(context.notifications).toContainEqual({
			message: "Plannotator requires Pi 0.79.1 or newer. Update Pi; project-local config is disabled on this host.",
			level: "warning",
		});
	});

	test("persistState records the framing latch on both sides", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		// Entering planning persists the reopened latch.
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "planning",
			framingDelivered: false,
		});

		await startAgent(runtime, context);
		// Delivering the framing persists the closed latch. This pins the
		// write side: dropping framingDelivered from persistState (or always
		// writing false) must fail here.
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "planning",
			framingDelivered: true,
		});
	});

	test("compaction reopens the latch and the framing is re-delivered exactly once", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		expect((await startAgent(runtime, context))?.message?.customType).toBe("plannotator-framing");
		expect(await startAgent(runtime, context)).toBeUndefined();

		// Compaction can summarize away the framing message from history.
		await runtime.run("session_compact", context, { reason: "threshold", willRetry: false });
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "planning",
			framingDelivered: false,
		});

		const redelivered = await startAgent(runtime, context);
		expect(redelivered?.message?.customType).toBe("plannotator-framing");
		expect(redelivered?.message?.content).toContain("[PLANNOTATOR - PLANNING PHASE]");
		// Once only: the following prompt injects nothing again.
		expect(await startAgent(runtime, context)).toBeUndefined();
	});

	test("compaction while idle does not touch state", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		const before = runtime.lastPersistedState();
		await runtime.run("session_compact", context, { reason: "manual", willRetry: false });
		expect(runtime.lastPersistedState()).toBe(before);
		expect(await startAgent(runtime, context)).toBeUndefined();
	});

	test("a tree switch to a path without plannotator state returns to idle", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect((await startAgent(runtime, context))?.message?.customType).toBe("plannotator-framing");

		// Branch to a point recorded before plannotator was ever active: the
		// new active path has no plannotator entries.
		const prePlannotatorPath = createContext({ cwd, entries: [] });
		await runtime.run("session_tree", prePlannotatorPath, { newLeafId: "n1", oldLeafId: "n2" });

		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "idle",
			framingDelivered: false,
		});
		expect(await startAgent(runtime, prePlannotatorPath)).toBeUndefined();
	});

	test("a tree switch resyncs phase and latch from the new active path", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n", "utf-8");
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		// Branch onto a path whose state entry recorded the executing phase
		// before its framing was delivered (latch open on that path).
		const executingPath = executingContext(cwd);
		await runtime.run("session_tree", executingPath, { newLeafId: "n1", oldLeafId: null });

		const first = await startAgent(runtime, executingPath);
		expect(first?.message?.customType).toBe("plannotator-framing");
		expect(first?.message?.content).toContain("planning phase is over");

		// A path that already delivered its framing keeps the latch closed.
		const deliveredPath = executingContext(cwd, { framingDelivered: true });
		await runtime.run("session_tree", deliveredPath, { newLeafId: "n2", oldLeafId: "n1" });
		const after = await startAgent(runtime, deliveredPath);
		expect(after?.message?.customType).toBe("plannotator-context");
	});

	test("obsolete systemPrompt config keys are ignored with a warning at session start", async () => {
		const cwd = makeWorkspace({
			phases: { planning: { systemPrompt: "OLD REPLACEMENT PROMPT" } },
		});
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		const configWarnings = context.notifications.filter(
			(n) => n.level === "warning" && n.message.includes('obsolete "systemPrompt"'),
		);
		expect(configWarnings).toHaveLength(1);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		const result = await startAgent(runtime, context);
		// The shipped instructions still apply; the old key changes nothing.
		expect(result?.message?.content).toContain("[PLANNOTATOR - PLANNING PHASE]");
		expect(result?.message?.content).not.toContain("OLD REPLACEMENT PROMPT");
		expect(result === undefined || !("systemPrompt" in result)).toBe(true);
	});
});

describe("Plannotator context filtering", () => {
	test("idle filters out all plannotator-injected messages", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		const kept = await filterContext(runtime, context, [
			{ role: "user", content: "real question" },
			framingMessage("planning"),
			todoMessage(),
			{ role: "user", content: "[PLANNOTATOR - PLANNING PHASE] legacy injected" },
			{ role: "assistant", content: "answer" },
		]);

		expect(kept?.map((m) => m.content)).toEqual(["real question", "answer"]);
	});

	test("executing drops stale planning framing and keeps only the current framing", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n", "utf-8");
		const runtime = createRuntime();
		const context = executingContext(cwd);
		await runtime.run("session_start", context);

		const kept = await filterContext(runtime, context, [
			framingMessage("planning"),
			{ role: "user", content: "please plan" },
			todoMessage("stale todo from an earlier cycle"),
			framingMessage("executing", "current executing framing"),
			todoMessage("current todo"),
			{ role: "assistant", content: "working" },
		]);

		expect(kept?.map((m) => m.content)).toEqual([
			"please plan",
			"current executing framing",
			"current todo",
			"working",
		]);
	});

	test("a planning re-entry keeps only the newest planning framing", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		const kept = await filterContext(runtime, context, [
			framingMessage("planning", "old cycle framing"),
			{ role: "user", content: "first cycle" },
			framingMessage("planning", "new cycle framing"),
			{ role: "user", content: "second cycle" },
		]);

		expect(kept?.map((m) => m.content)).toEqual(["first cycle", "new cycle framing", "second cycle"]);
	});

	test("an active phase without its own framing still drops other-phase framing", async () => {
		const cwd = makeWorkspace({ phases: { executing: { instructions: null } } });
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n", "utf-8");
		const runtime = createRuntime();
		const context = executingContext(cwd);
		await runtime.run("session_start", context);

		const kept = await filterContext(runtime, context, [
			framingMessage("planning"),
			{ role: "user", content: "prompt" },
			todoMessage("current todo"),
		]);

		expect(kept?.map((m) => m.content)).toEqual(["prompt", "current todo"]);
	});
});
