import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator, { PROJECT_TRUST_CAPABILITY_WARNING } from "./index.ts";

type Handler = (event: unknown, context: ReturnType<typeof createContext>) => unknown;

type SessionEntry = {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; content: Array<{ type: string; text: string }> };
};

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

describe("Plannotator phase framing messages", () => {
	test("before_agent_start never returns a systemPrompt in any phase", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n- [ ] Step two\n", "utf-8");
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		const results: PromptResult[] = [];
		results.push(await startAgent(runtime, context));
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		results.push(await startAgent(runtime, context));
		results.push(await startAgent(runtime, context));
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		const executing = executingContext(cwd);
		const executingRuntime = createRuntime();
		await executingRuntime.run("session_start", executing);
		results.push(await startAgent(executingRuntime, executing));
		results.push(await startAgent(executingRuntime, executing));

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
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect((await startAgent(runtime, context))?.message?.details).toEqual({ phase: "idle" });
		expect(await startAgent(runtime, context)).toBeUndefined();

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
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
		expect(first?.message?.content).toContain("- [ ] 1. Step one");

		const second = await startAgent(runtime, context);
		expect(second?.message?.customType).toBe("plannotator-context");
		expect(second?.message?.content).toContain("0/2 steps complete");
		expect(second?.message?.content).toContain("- [ ] 1. Step one");
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

	test("resync persists completion markers that predate checklist persistence", async () => {
		const cwd = makeWorkspace();
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, "# Plan\n\n- [ ] Step one\n- [ ] Step two\n", "utf-8");
		const runtime = createRuntime();
		const context = createContext({
			cwd,
			entries: [
				{
					type: "custom",
					customType: "plannotator",
					data: {
						phase: "executing",
						lastSubmittedPath: "PLAN.md",
						savedState: { thinkingLevel: "medium" },
					},
				},
				{ type: "custom", customType: "plannotator-execute" },
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "Finished. [DONE:1]" }] },
				},
			],
		});

		await runtime.run("session_start", context);

		expect(readFileSync(planPath, "utf-8")).toBe("# Plan\n\n- [x] Step one\n- [ ] Step two\n");
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
		expect(context.notifications).not.toContainEqual({
			message: PROJECT_TRUST_CAPABILITY_WARNING,
			level: "warning",
		});
	});

	test("loads project Plannotator config when the host reports project trust", async () => {
		const cwd = makeWorkspace({
			phases: { planning: { instructions: "trusted-project-instructions" } },
		});
		const runtime = createRuntime();
		const context = createContext({ cwd, projectTrusted: true });
		await runtime.run("session_start", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		const result = await startAgent(runtime, context);
		expect(result?.message?.content).toContain("trusted-project-instructions");
		expect(context.notifications).not.toContainEqual({
			message: PROJECT_TRUST_CAPABILITY_WARNING,
			level: "warning",
		});
	});

	test("fails closed with the capability warning when the host lacks project trust support", async () => {
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
			message:
				"This host does not expose project trust (ctx.isProjectTrusted, Pi 0.79.1+). Project-local config (.pi/plannotator.json) is disabled; bundled and global config still load.",
			level: "warning",
		});
	});

	test("a throwing isProjectTrusted propagates and keeps project config unloaded", async () => {
		const cwd = makeWorkspace({
			phases: { planning: { instructions: "untrusted-project-instructions" } },
		});
		const runtime = createRuntime();
		const context = createContext({ cwd });
		(context as { isProjectTrusted: () => boolean }).isProjectTrusted = () => {
			throw new Error("stale context");
		};

		await expect(runtime.run("session_start", context)).rejects.toThrow("stale context");
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		const result = await startAgent(runtime, context);
		expect(result?.message?.content ?? "").not.toContain("untrusted-project-instructions");
	});

	test("persistState records the framing latch on both sides", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "planning",
			framingDelivered: false,
		});

		await startAgent(runtime, context);
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

		await runtime.run("session_compact", context, { reason: "threshold", willRetry: false });
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "planning",
			framingDelivered: false,
		});

		const redelivered = await startAgent(runtime, context);
		expect(redelivered?.message?.customType).toBe("plannotator-framing");
		expect(redelivered?.message?.content).toContain("[PLANNOTATOR - PLANNING PHASE]");
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

		const executingPath = executingContext(cwd);
		await runtime.run("session_tree", executingPath, { newLeafId: "n1", oldLeafId: null });

		const first = await startAgent(runtime, executingPath);
		expect(first?.message?.customType).toBe("plannotator-framing");
		expect(first?.message?.content).toContain("planning phase is over");

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
		expect(result?.message?.content).toContain("[PLANNOTATOR - PLANNING PHASE]");
		expect(result?.message?.content).not.toContain("OLD REPLACEMENT PROMPT");
		expect(result === undefined || !("systemPrompt" in result)).toBe(true);
	});
});

describe("Plannotator plan-mode-off countermand (#1320)", () => {
	test("toggling plan mode off delivers the plan-mode-off notice exactly once", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect((await startAgent(runtime, context))?.message?.customType).toBe("plannotator-framing");

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "idle",
			idleNoticePending: true,
		});

		const notice = await startAgent(runtime, context);
		expect(notice?.message?.customType).toBe("plannotator-framing");
		expect(notice?.message?.display).toBe(false);
		expect(notice?.message?.details).toEqual({ phase: "idle" });
		expect(notice?.message?.content).toContain("[PLANNOTATOR - PLAN MODE OFF]");
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "idle",
			idleNoticePending: false,
		});

		expect(await startAgent(runtime, context)).toBeUndefined();
		expect(await startAgent(runtime, context)).toBeUndefined();
	});

	test("plan completion (executing → idle) also delivers the notice", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [x] Step one\n- [x] Step two\n", "utf-8");
		const runtime = createRuntime();
		const context = executingContext(cwd, { framingDelivered: true });
		await runtime.run("session_start", context);

		await runtime.run("agent_end", context, {});
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "idle",
			idleNoticePending: true,
		});

		const notice = await startAgent(runtime, context);
		expect(notice?.message?.details).toEqual({ phase: "idle" });
		expect(notice?.message?.content).toContain("[PLANNOTATOR - PLAN MODE OFF]");
		expect(await startAgent(runtime, context)).toBeUndefined();
	});

	test("resync fallback: a recorded executing phase whose plan file is gone demotes to idle WITH the notice armed", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = executingContext(cwd, { framingDelivered: true });
		await runtime.run("session_start", context);

		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "idle",
			idleNoticePending: true,
		});
		const notice = await startAgent(runtime, context);
		expect(notice?.message?.content).toContain("[PLANNOTATOR - PLAN MODE OFF]");
		expect(await startAgent(runtime, context)).toBeUndefined();
	});

	test("resync fallback: a recorded executing phase with no submitted path demotes to idle WITH the notice armed", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({
			cwd,
			entries: [
				{
					type: "custom",
					customType: "plannotator",
					data: { phase: "executing", framingDelivered: true },
				},
			],
		});
		await runtime.run("session_start", context);

		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "idle",
			idleNoticePending: true,
		});
		const notice = await startAgent(runtime, context);
		expect(notice?.message?.content).toContain("[PLANNOTATOR - PLAN MODE OFF]");
		expect(await startAgent(runtime, context)).toBeUndefined();
	});

	test("fresh sessions never deliver the notice: the #1269 inject-nothing promise holds", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		expect(await startAgent(runtime, context)).toBeUndefined();
		expect(await startAgent(runtime, context)).toBeUndefined();
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "idle",
			idleNoticePending: false,
		});
	});

	test("a resumed idle session that already delivered the notice does not repeat it", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({
			cwd,
			entries: [
				{
					type: "custom",
					customType: "plannotator",
					data: { phase: "idle", framingDelivered: false, idleNoticePending: false },
				},
			],
		});
		await runtime.run("session_start", context);

		expect(await startAgent(runtime, context)).toBeUndefined();
	});

	test("a path that recorded the toggle-off but not the delivery still owes the notice", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		const pendingPath = createContext({
			cwd,
			entries: [
				{
					type: "custom",
					customType: "plannotator",
					data: { phase: "idle", framingDelivered: false, idleNoticePending: true },
				},
			],
		});
		await runtime.run("session_tree", pendingPath, { newLeafId: "n1", oldLeafId: null });

		const notice = await startAgent(runtime, pendingPath);
		expect(notice?.message?.content).toContain("[PLANNOTATOR - PLAN MODE OFF]");
		expect(await startAgent(runtime, pendingPath)).toBeUndefined();
	});

	test("re-entering planning supersedes an undelivered notice", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect((await startAgent(runtime, context))?.message?.customType).toBe("plannotator-framing");
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "planning",
			idleNoticePending: false,
		});

		const reentry = await startAgent(runtime, context);
		expect(reentry?.message?.content).toContain("[PLANNOTATOR - PLANNING PHASE]");
		expect(reentry?.message?.details).toEqual({ phase: "planning" });

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect((await startAgent(runtime, context))?.message?.content).toContain(
			"[PLANNOTATOR - PLAN MODE OFF]",
		);
	});
});

describe("Plannotator append-only conversation (#1380)", () => {
	async function requestView(
		runtime: ReturnType<typeof createRuntime>,
		context: ReturnType<typeof createContext>,
		history: ContextMessage[],
	): Promise<ContextMessage[]> {
		const results = await runtime.run("context", context, { messages: history });
		for (const result of results) {
			const shaped = (result as { messages?: ContextMessage[] } | undefined)?.messages;
			if (shaped) return shaped;
		}
		return history;
	}

	function toInjected(result: PromptResult): ContextMessage {
		if (!result?.message) throw new Error("expected an injected message");
		return {
			role: "custom",
			customType: result.message.customType,
			content: result.message.content,
			details: result.message.details,
		};
	}

	test("the outgoing request stays prefix-stable across planning, executing, and back to idle", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n", "utf-8");
		const runtime = createRuntime();
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		const history: ContextMessage[] = [];
		const assertExtends = (next: ContextMessage[], prev: ContextMessage[]): void => {
			expect(next.length).toBeGreaterThanOrEqual(prev.length);
			for (let i = 0; i < prev.length; i++) {
				expect(JSON.stringify(next[i])).toBe(JSON.stringify(prev[i]));
			}
		};

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		history.push({ role: "user", content: "plan this" });
		history.push(toInjected(await startAgent(runtime, context)));
		history.push({ role: "assistant", content: "drafted the plan" });
		const planningRequest = await requestView(runtime, context, history);
		assertExtends(planningRequest, []);

		const executingPath = executingContext(cwd);
		await runtime.run("session_tree", executingPath, { newLeafId: "n1", oldLeafId: null });
		history.push({ role: "user", content: "approved, go" });
		history.push(toInjected(await startAgent(runtime, executingPath)));
		history.push({ role: "assistant", content: "working [DONE:1]" });
		const executingRequest = await requestView(runtime, executingPath, history);
		assertExtends(executingRequest, planningRequest);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", executingPath);
		const notice = await startAgent(runtime, executingPath);
		expect(notice?.message?.content).toContain("[PLANNOTATOR - PLAN MODE OFF]");
		history.push(toInjected(notice));
		const idleRequest = await requestView(runtime, executingPath, history);
		assertExtends(idleRequest, executingRequest);
		expect(idleRequest[idleRequest.length - 1]?.content).toContain("[PLANNOTATOR - PLAN MODE OFF]");
	});

	test("phase framing carries the superseding language that replaced removal", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step one\n", "utf-8");

		const planningRuntime = createRuntime();
		const planningCtx = createContext({ cwd });
		await planningRuntime.run("session_start", planningCtx);
		await planningRuntime.commands.get("plannotator-plan-mode")?.handler("", planningCtx);
		const planning = await startAgent(planningRuntime, planningCtx);
		expect(planning?.message?.content).toContain(
			"supersedes every earlier Plannotator instruction",
		);

		const executingRuntime = createRuntime();
		const executing = executingContext(cwd);
		await executingRuntime.run("session_start", executing);
		const framing = await startAgent(executingRuntime, executing);
		expect(framing?.message?.content).toContain(
			"supersedes every earlier Plannotator instruction",
		);
	});
});
