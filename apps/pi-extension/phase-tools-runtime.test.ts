import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";

type Handler = (event: unknown, context: ReturnType<typeof createContext>) => unknown;

type SessionEntry = { type: string; customType?: string; data?: unknown };

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
	const home = makeTempDir("plannotator-phase-home-");
	const cwd = makeTempDir("plannotator-phase-cwd-");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

	if (projectConfig !== undefined) {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "plannotator.json"), JSON.stringify(projectConfig), "utf-8");
	}

	return cwd;
}

function createContext(options: { cwd?: string; entries?: SessionEntry[] } = {}) {
	const entries = options.entries ?? [];
	return {
		cwd: options.cwd ?? process.cwd(),
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => true,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
			getSessionFile: () => undefined,
			getSessionId: () => "test-session",
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
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

function createRuntime(initialTools: string[]) {
	const commands = new Map<string, { handler: (args: string, context: ReturnType<typeof createContext>) => unknown }>();
	const handlers = new Map<string, Handler[]>();
	const persisted: Array<Record<string, unknown>> = [];
	const tools = new Map<string, Record<string, unknown>>();
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
		registerTool: (tool: Record<string, unknown>) => {
			tools.set(tool.name as string, tool);
		},
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
		getActiveTools: () => activeTools,
		lastPersistedState: () => persisted.at(-1),
		run: async (event: string, context: ReturnType<typeof createContext>) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, context);
		},
		setActiveTools: (tools: string[]) => {
			activeTools = [...tools];
		},
		tools,
	};
}

describe("Plannotator phase tool ownership", () => {
	// Deliberate pin (#1622): pi's agent loop runs a batch sequentially only when
	// some tool in it declares executionMode "sequential". Without it, an
	// "edit plan + plannotator_submit_plan" batch runs in parallel and the submit
	// reads the plan file before pi's queued edit lands, reviewing a stale plan.
	test("the submit tool forces pi to run its tool batch sequentially", () => {
		const runtime = createRuntime([]);
		expect(runtime.tools.get("plannotator_submit_plan")?.executionMode).toBe("sequential");
	});

	test("leaving planning removes only tools Plannotator added", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime([
			"inspect",
			"search",
			"plannotator_submit_plan",
		]);
		const context = createContext({ cwd });
		await runtime.run("session_start", context);
		expect(runtime.getActiveTools()).toEqual(["inspect", "search"]);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual([
			"inspect",
			"search",
			"grep",
			"find",
			"ls",
			"plannotator_submit_plan",
		]);

		runtime.setActiveTools(["search", "external_new", "plannotator_submit_plan"]);
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual(["search", "external_new"]);
	});

	test("planning adds the default discovery tools and releases them on exit", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime(["read", "bash", "edit", "write"]);
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			"plannotator_submit_plan",
		]);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
	});

	test("a discovery tool already active before planning survives the exit", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime(["read", "bash", "grep"]);
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual([
			"read",
			"bash",
			"grep",
			"find",
			"ls",
			"plannotator_submit_plan",
		]);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual(["read", "bash", "grep"]);
	});

	test("user config still overrides the default planning tools", async () => {
		const cwd = makeWorkspace({
			phases: { planning: { activeTools: ["my_planning_tool"] } },
		});
		const runtime = createRuntime(["read", "bash"]);
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual([
			"read",
			"bash",
			"my_planning_tool",
			"plannotator_submit_plan",
		]);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual(["read", "bash"]);
	});

	test("custom planning tools keep the submit tool and release it on exit", async () => {
		const cwd = makeWorkspace({
			phases: { planning: { activeTools: ["my_planning_tool"] } },
		});
		const runtime = createRuntime(["read", "bash"]);
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		const planningTools = runtime.getActiveTools();
		expect(planningTools).toContain("my_planning_tool");
		expect(planningTools).toContain("plannotator_submit_plan");
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "planning",
			phaseAddedTools: ["my_planning_tool", "plannotator_submit_plan"],
		});

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		const exitTools = runtime.getActiveTools();
		expect(exitTools).not.toContain("my_planning_tool");
		expect(exitTools).not.toContain("plannotator_submit_plan");
		expect(exitTools).toEqual(["read", "bash"]);
	});

	test("a custom planning config that already lists the submit tool adds it once", async () => {
		const cwd = makeWorkspace({
			phases: {
				planning: { activeTools: ["plannotator_submit_plan", "my_planning_tool"] },
			},
		});
		const runtime = createRuntime(["read", "bash"]);
		const context = createContext({ cwd });
		await runtime.run("session_start", context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual([
			"read",
			"bash",
			"plannotator_submit_plan",
			"my_planning_tool",
		]);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.getActiveTools()).toEqual(["read", "bash"]);
	});

	test("completing the plan releases the executing phase tools", async () => {
		const cwd = makeWorkspace({
			phases: { executing: { activeTools: ["my_tool"] } },
		});
		writeFileSync(join(cwd, "PLAN.md"), "- [x] Step one\n- [x] Step two\n", "utf-8");

		const runtime = createRuntime(["read", "bash"]);
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
			],
		});

		await runtime.run("session_start", context);
		// The executing phase unions the mark-done tool in beside the user's
		// configured tools, exactly like planning unions the submit tool.
		expect(runtime.getActiveTools()).toEqual([
			"read",
			"bash",
			"my_tool",
			"plannotator_mark_done",
		]);
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "executing",
			phaseAddedTools: ["my_tool", "plannotator_mark_done"],
		});

		await runtime.run("agent_end", context);
		const exitTools = runtime.getActiveTools();
		expect(exitTools).not.toContain("plannotator_mark_done");
		expect(exitTools).toEqual(["read", "bash"]);
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "idle",
			phaseAddedTools: [],
		});
	});
});

type ModelRef = { provider: string; id: string };

/** The host's own default thinking level, applied on every model switch. */
const HOST_DEFAULT_THINKING = "minimal";

type ModelHostOptions = {
	cwd: string;
	initialModel: ModelRef;
	initialThinking?: string;
	entries: SessionEntry[];
	/** oh-my-pi: no model_select or thinking_level_select, and a model switch keeps the thinking level. */
	omp?: boolean;
	/** Another extension listens to thinking_level_select ahead of Plannotator, so Pi reaches Plannotator later. */
	thinkingListenerAhead?: boolean;
	/** The registry resolves a configured model id to another id, as an alias does. */
	registryIds?: Record<string, string>;
};

/**
 * A host whose model and thinking level are real state: `setModel` changes the
 * model the context reports and every call is recorded, so a test can tell a
 * model Plannotator set apart from one the user picked. The Pi host records
 * model and thinking changes on the session branch and reports them the way Pi
 * does (agent-session.ts setModel / setThinkingLevel).
 */
function createModelHost(options: ModelHostOptions) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, context: ReturnType<typeof createContext>) => unknown }>();
	const registeredTools = new Map<string, { name: string; execute: (...args: any[]) => Promise<unknown> }>();
	const host = {
		model: options.initialModel,
		thinking: options.initialThinking ?? "medium",
		modelCalls: [] as ModelRef[],
		thinkingCalls: [] as string[],
		entries: options.entries,
	};
	const tools = { active: ["read", "bash", "edit", "write"] };
	let nextEntryId = 0;
	const emit = (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, context as never);
	};

	// Pi's setThinkingLevel: a real change is written to the branch, then
	// reported with no word on who made it.
	const changeThinking = (level: string) => {
		if (options.omp) {
			host.thinking = level;
			return;
		}
		const previousLevel = host.thinking;
		if (level === previousLevel) return;
		host.thinking = level;
		host.entries.push({ type: "thinking_level_change", id: `host-${nextEntryId++}`, thinkingLevel: level } as SessionEntry);
		const report = () => emit("thinking_level_select", { type: "thinking_level_select", level, previousLevel });
		if (options.thinkingListenerAhead) void Promise.resolve().then(report);
		else report();
	};

	// Pi's setModel: the model moves, the switch is written, the thinking level is
	// re-derived from the host default, then model_select. oh-my-pi keeps the
	// thinking level and reports nothing.
	const switchModel = async (model: ModelRef) => {
		const previousModel = host.model;
		host.model = model;
		if (options.omp) return;
		host.entries.push({ type: "model_change", id: `host-${nextEntryId++}`, provider: model.provider, modelId: model.id } as SessionEntry);
		changeThinking(HOST_DEFAULT_THINKING);
		if (previousModel.provider !== model.provider || previousModel.id !== model.id) {
			for (const handler of handlers.get("model_select") ?? []) await handler({ source: "set", model, previousModel }, context as never);
		}
	};

	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			host.entries.push({ type: "custom", customType, data });
		},
		events: { on: () => () => undefined },
		getActiveTools: () => [...tools.active],
		getFlag: () => false,
		getThinkingLevel: () => host.thinking,
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: { handler: (args: string, context: ReturnType<typeof createContext>) => unknown }) => commands.set(name, command),
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<unknown> }) => registeredTools.set(tool.name, tool),
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: (next: string[]) => {
			tools.active = [...next];
		},
		setModel: async (model: ModelRef) => {
			host.modelCalls.push({ provider: model.provider, id: model.id });
			await switchModel(model);
			return true;
		},
		setThinkingLevel: (level: string) => {
			host.thinkingCalls.push(level);
			changeThinking(level);
		},
	};
	plannotator(pi as never);

	const base = createContext({ cwd: options.cwd, entries: host.entries });
	const context = {
		...base,
		get model() {
			return host.model;
		},
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id: options.registryIds?.[id] ?? id }) },
	};

	return {
		host,
		tools,
		command: async () => commands.get("plannotator-plan-mode")!.handler("", context as never),
		submit: async () => registeredTools.get("plannotator_submit_plan")!.execute("call", { filePath: "PLAN.md" }, undefined, undefined, context),
		markDone: async (step: number) => registeredTools.get("plannotator_mark_done")!.execute("done", { step }, undefined, undefined, context),
		/**
		 * The user picks a model in the host's own UI, not through Plannotator,
		 * then (if given) a thinking level.
		 */
		userPicks: (model: ModelRef, thinking?: string) => {
			void switchModel(model);
			if (thinking) changeThinking(thinking);
			host.modelCalls.length = 0;
			host.thinkingCalls.length = 0;
		},
		/** The user changes only the thinking level (Pi's /thinking or shift+tab). */
		userSetsThinking: (level: string) => {
			changeThinking(level);
		},
		/** The host changes the level by itself (oh-my-pi's auto thinking re-resolving for a turn). */
		hostDriftsThinking: (level: string) => {
			host.thinking = level;
		},
		/** oh-my-pi moves to a fallback model after a provider error. */
		hostFallsBack: (model: ModelRef) => {
			const from = `${host.model.provider}/${host.model.id}`;
			host.model = model;
			emit("retry_fallback_applied", { type: "retry_fallback_applied", from, to: `${model.provider}/${model.id}`, role: "default" });
		},
		/** oh-my-pi goes back to the primary model once the fallback cools down, without an extension event. */
		hostRestoresPrimary: (model: ModelRef) => {
			host.model = model;
		},
		/** Let a thinking report delayed by an earlier listener arrive. */
		settle: () => new Promise((resolveSettle) => setTimeout(resolveSettle, 0)),
		run: async (event: string) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, context as never);
		},
	};
}

const SOL = { provider: "openai", id: "gpt-6-sol" };
const LUNA = { provider: "openai", id: "gpt-6-luna" };
const ASTRA = { provider: "openai", id: "gpt-6-astra" };
const PLAN = "- [ ] Step one\n- [ ] Step two\n";

describe("Plannotator preserves user model selections during plan transitions", () => {
	test("approval and completion preserve a model and thinking level changed during the plan", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		runtime.userPicks(LUNA, "high");
		await runtime.submit();
		expect(runtime.host.model).toEqual(LUNA);
		expect(runtime.host.thinking).toBe("high");
		// The first agent_end after approval only schedules the continuation.
		await runtime.run("agent_end");
		await runtime.markDone(1);
		await runtime.markDone(2);
		await runtime.run("agent_end");
		const state = runtime.host.entries.filter((entry) => entry.customType === "plannotator").at(-1)?.data as { phase?: string };
		expect(state.phase).toBe("idle");
		expect(runtime.host.model).toEqual(LUNA);
		expect(runtime.host.thinking).toBe("high");
	});

	test("a temporary configured planning model still restores the original if the user did not change it", async () => {
		const cwd = makeWorkspace({ phases: { planning: { model: LUNA, thinking: "low" } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		expect(runtime.host.model).toEqual(LUNA);
		await runtime.submit();
		expect(runtime.host.model).toEqual(SOL);
		expect(runtime.host.thinking).toBe("medium");
	});

	test("a user choice after a configured planning model becomes the restored baseline", async () => {
		const cwd = makeWorkspace({ phases: { planning: { model: LUNA, thinking: "low" } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		runtime.userPicks(ASTRA, "high");
		await runtime.submit();
		expect(runtime.host.model).toEqual(ASTRA);
		expect(runtime.host.thinking).toBe("high");
	});

	test("a model chosen during execution survives completion", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.submit();
		runtime.userPicks(LUNA, "high");
		// The first agent_end after approval only schedules the continuation.
		await runtime.run("agent_end");
		await runtime.markDone(1);
		await runtime.markDone(2);
		await runtime.run("agent_end");
		const state = runtime.host.entries.filter((entry) => entry.customType === "plannotator").at(-1)?.data as { phase?: string };
		expect(state.phase).toBe("idle");
		expect(runtime.host.model).toEqual(LUNA);
		expect(runtime.host.thinking).toBe("high");
	});

	test("a manual selection wins over a configured executing model at approval", async () => {
		const cwd = makeWorkspace({ phases: { planning: { model: LUNA }, executing: { model: SOL, thinking: "low" } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		runtime.userPicks(ASTRA, "high");
		await runtime.submit();
		expect(runtime.host.model).toEqual(ASTRA);
		expect(runtime.host.thinking).toBe("high");
	});

	test("resuming a planning session keeps a manual model choice", async () => {
		const cwd = makeWorkspace({ phases: { planning: { model: LUNA, thinking: "low" } } });
		const first = createModelHost({ cwd, initialModel: SOL, entries: [] });
		await first.run("session_start");
		await first.command();
		first.userPicks(ASTRA, "high");
		const resumed = createModelHost({ cwd, initialModel: ASTRA, initialThinking: "high", entries: structuredClone(first.host.entries) });
		await resumed.run("session_start");
		expect(resumed.host.model).toEqual(ASTRA);
		expect(resumed.host.thinking).toBe("high");
	});

	test("resuming execution does not reapply a profile over a persisted user choice", async () => {
		const cwd = makeWorkspace({ phases: { planning: { model: LUNA }, executing: { model: SOL, thinking: "low" } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const first = createModelHost({ cwd, initialModel: SOL, entries: [] });
		await first.run("session_start");
		await first.command();
		first.userPicks(ASTRA, "high");
		await first.submit();
		const resumed = createModelHost({ cwd, initialModel: ASTRA, initialThinking: "high", entries: structuredClone(first.host.entries) });
		await resumed.run("session_start");
		expect(resumed.host.model).toEqual(ASTRA);
		expect(resumed.host.thinking).toBe("high");
	});

	test("a user choosing away from and back to the current model still wins over the next phase", async () => {
		const cwd = makeWorkspace({ phases: { executing: { model: LUNA } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		runtime.userPicks(ASTRA);
		runtime.userPicks(SOL);
		await runtime.submit();
		expect(runtime.host.model).toEqual(SOL);
	});
});

function executingEntries(): SessionEntry[] {
	return [
		{
			type: "custom",
			customType: "plannotator",
			data: {
				phase: "executing",
				lastSubmittedPath: "PLAN.md",
				savedState: { model: SOL, thinkingLevel: "medium" },
				phaseAddedTools: [],
				framingDelivered: true,
			},
		},
		{ type: "custom", customType: "plannotator-execute", data: { lastSubmittedPath: "PLAN.md", approvedPlan: PLAN } },
	];
}

describe("Plannotator keeps the user's model across /tree (#1722)", () => {
	test("a /tree navigation that stays executing keeps a model picked during execution", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: executingEntries() });
		await runtime.run("session_start");

		runtime.userPicks(LUNA, "high");
		// Re-answering an earlier Ask lands on another node of the same
		// executing path.
		await runtime.run("session_tree");

		expect(runtime.host.model).toEqual(LUNA);
		expect(runtime.host.thinking).toBe("high");
		expect(runtime.host.modelCalls).toEqual([]);
		expect(runtime.host.thinkingCalls).toEqual([]);
		// Tools are still re-derived from the path.
		expect(runtime.tools.active).toContain("plannotator_mark_done");
	});

	test("a configured executing model is not re-applied over the user's pick either", async () => {
		const cwd = makeWorkspace({ phases: { executing: { model: SOL, thinking: "low" } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: executingEntries() });
		await runtime.run("session_start");

		runtime.userPicks(LUNA, "high");
		await runtime.run("session_tree");

		expect(runtime.host.model).toEqual(LUNA);
		expect(runtime.host.modelCalls).toEqual([]);
		expect(runtime.host.thinkingCalls).toEqual([]);
	});

	test("a /tree navigation into planning still applies the planning model", async () => {
		const cwd = makeWorkspace({ phases: { planning: { model: SOL } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: executingEntries() });
		await runtime.run("session_start");

		runtime.userPicks(LUNA);
		runtime.host.entries.push({
			type: "custom",
			customType: "plannotator",
			data: { phase: "planning", lastSubmittedPath: "PLAN.md", savedState: { model: SOL, thinkingLevel: "medium" } },
		});
		await runtime.run("session_tree");

		expect(runtime.host.model).toEqual(SOL);
		expect(runtime.host.modelCalls.at(-1)).toEqual(SOL);
	});

	test("a /tree navigation out of plan mode preserves a later user choice", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: executingEntries() });
		await runtime.run("session_start");

		runtime.userPicks(LUNA);
		// A path from before plan mode: no plannotator state at all.
		runtime.host.entries.length = 0;
		await runtime.run("session_tree");

		expect(runtime.host.model).toEqual(LUNA);
		expect(runtime.host.modelCalls).toEqual([]);
	});
});

function lastState(entries: SessionEntry[]) {
	return entries.filter((entry) => entry.customType === "plannotator").at(-1)?.data as { phase?: string; savedState?: Record<string, unknown> };
}

/** Pi reports a model pick with model_select; oh-my-pi has no such event. */
const HOSTS = [
	{ name: "Pi", omp: false },
	{ name: "oh-my-pi", omp: true },
];

describe("Plannotator re-applies phase settings after /tree into another phase", () => {
	for (const { name, omp } of HOSTS) {
		test(`${name}: /tree from execution back to the planning node applies the planning profile, and leaving plan mode restores the pre-plan settings`, async () => {
			const cwd = makeWorkspace({ phases: { planning: { model: LUNA, thinking: "low" }, executing: { model: ASTRA, thinking: "high" } } });
			writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			const planningNode = runtime.host.entries.length;
			await runtime.submit();
			expect([runtime.host.model, runtime.host.thinking]).toEqual([ASTRA, "high"]);

			// /tree to the planning node: the host keeps the executing model.
			runtime.host.entries.length = planningNode;
			await runtime.run("session_tree");
			expect(lastState(runtime.host.entries).phase).toBe("planning");
			expect([runtime.host.model, runtime.host.thinking]).toEqual([LUNA, "low"]);

			await runtime.command();
			expect([runtime.host.model, runtime.host.thinking]).toEqual([SOL, "xhigh"]);
		});

		test(`${name}: /tree from after completion back into execution applies the executing profile`, async () => {
			const cwd = makeWorkspace({ phases: { executing: { model: ASTRA, thinking: "high" } } });
			writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			await runtime.submit();
			const executingPath = runtime.host.entries.slice();
			await runtime.run("agent_end");
			await runtime.markDone(1);
			await runtime.markDone(2);
			await runtime.run("agent_end");
			expect(lastState(runtime.host.entries).phase).toBe("idle");
			expect([runtime.host.model, runtime.host.thinking]).toEqual([SOL, "xhigh"]);

			// /tree back into execution: the host keeps the pre-plan model.
			writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
			runtime.host.entries.splice(0, runtime.host.entries.length, ...executingPath);
			await runtime.run("session_tree");
			expect(lastState(runtime.host.entries).phase).toBe("executing");
			expect([runtime.host.model, runtime.host.thinking]).toEqual([ASTRA, "high"]);

			// Completing the plan on this branch gives back the pre-plan settings, not the executing ones.
			await runtime.run("agent_end");
			await runtime.markDone(1);
			await runtime.markDone(2);
			await runtime.run("agent_end");
			expect(lastState(runtime.host.entries).phase).toBe("idle");
			expect([runtime.host.model, runtime.host.thinking]).toEqual([SOL, "xhigh"]);
		});
	}
});

async function completePlan(runtime: ReturnType<typeof createModelHost>) {
	// The first agent_end after approval only schedules the continuation.
	await runtime.run("agent_end");
	await runtime.markDone(1);
	await runtime.markDone(2);
	await runtime.run("agent_end");
	expect(lastState(runtime.host.entries).phase).toBe("idle");
}

describe("Plannotator counts a thinking level as the user's only when the user set it", () => {
	test("Pi: a thinking level the user sets mid-plan survives approval and completion, while the pre-plan model comes back", async () => {
		const cwd = makeWorkspace({ phases: { planning: { model: LUNA, thinking: "low" } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		runtime.userSetsThinking("medium");
		await runtime.submit();
		expect([runtime.host.model, runtime.host.thinking]).toEqual([SOL, "medium"]);
		await completePlan(runtime);
		expect([runtime.host.model, runtime.host.thinking]).toEqual([SOL, "medium"]);
	});

	for (const { name, omp } of HOSTS) {
		test(`${name}: a thinking level the host changed by itself does not block the configured executing thinking`, async () => {
			const cwd = makeWorkspace({ phases: { executing: { thinking: "low" } } });
			writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "medium", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			// oh-my-pi's auto thinking resolves a new level for a turn.
			runtime.hostDriftsThinking("high");
			await runtime.submit();
			expect(runtime.host.thinking).toBe("low");
			await completePlan(runtime);
			expect([runtime.host.model, runtime.host.thinking]).toEqual([SOL, "medium"]);
		});
	}

	test("Pi: the thinking reset that comes with a model pick is not a thinking choice", async () => {
		const cwd = makeWorkspace({ phases: { executing: { thinking: "low" } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		// Pi's /model: setModel resets thinking to the host default, then model_select.
		runtime.userPicks(LUNA);
		expect(runtime.host.thinking).toBe(HOST_DEFAULT_THINKING);
		await runtime.submit();
		expect([runtime.host.model, runtime.host.thinking]).toEqual([LUNA, "low"]);
		await completePlan(runtime);
		expect([runtime.host.model, runtime.host.thinking]).toEqual([LUNA, "xhigh"]);
	});

	test("Pi, with another thinking listener ahead of Plannotator: Plannotator's own thinking changes are not taken for the user's", async () => {
		const cwd = makeWorkspace({ phases: { planning: { thinking: "low" }, executing: { thinking: "medium" } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], thinkingListenerAhead: true });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.settle();
		expect(runtime.host.thinking).toBe("low");
		await runtime.submit();
		await runtime.settle();
		expect(runtime.host.thinking).toBe("medium");
		await completePlan(runtime);
		await runtime.settle();
		expect([runtime.host.model, runtime.host.thinking]).toEqual([SOL, "xhigh"]);
	});

	test("Pi, with another thinking listener ahead of Plannotator: a model pick's thinking reset is still not a choice, a later thinking change is", async () => {
		const cwd = makeWorkspace({ phases: { executing: { thinking: "low" } } });
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const first = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], thinkingListenerAhead: true });
		await first.run("session_start");
		await first.command();
		first.userPicks(LUNA);
		await first.settle();
		await first.submit();
		expect([first.host.model, first.host.thinking]).toEqual([LUNA, "low"]);

		const cwd2 = makeWorkspace({ phases: { executing: { thinking: "low" } } });
		writeFileSync(join(cwd2, "PLAN.md"), PLAN, "utf-8");
		const second = createModelHost({ cwd: cwd2, initialModel: SOL, initialThinking: "xhigh", entries: [], thinkingListenerAhead: true });
		await second.run("session_start");
		await second.command();
		second.userPicks(LUNA, "high");
		await second.settle();
		await second.submit();
		expect([second.host.model, second.host.thinking]).toEqual([LUNA, "high"]);
	});
});
