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

/** Pi's thinking level after a model switch when no per-model level is set: its settings default. */
const HOST_DEFAULT_THINKING = "minimal";

type ModelHostOptions = {
	cwd: string;
	initialModel: ModelRef;
	initialThinking?: string;
	entries: SessionEntry[];
	/**
	 * oh-my-pi: its ExtensionAPI carries `arktype` and `pi`, so the extension
	 * detects it (pi-host.ts). It has no model_select or thinking_level_select,
	 * and a model switch keeps the thinking level.
	 */
	omp?: boolean;
	/** The registry resolves a configured model id to another id, as an alias does. */
	registryIds?: Record<string, string>;
	/** Another extension loaded before Plannotator: its listeners run first. */
	before?: (api: { on: (event: string, handler: Handler) => void; appendEntry: (customType: string, data: unknown) => void }) => void;
};

/**
 * A host whose model and thinking level are real state, following Pi's
 * agent-session.ts: handlers run in registration order, each awaited. setModel
 * moves the model, writes a model_change entry, resets the thinking level, then
 * awaits model_select (skipped when the model did not change) with source
 * "set", which an extension's pi.setModel gets too, or "cycle". setThinkingLevel
 * writes a thinking_level_change entry and reports it without waiting.
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
	const emit = async (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, context as never);
	};

	const changeThinking = (level: string) => {
		const previousLevel = host.thinking;
		if (level === previousLevel) return;
		host.thinking = level;
		if (options.omp) return;
		host.entries.push({ type: "thinking_level_change", id: `host-${nextEntryId++}`, thinkingLevel: level } as SessionEntry);
		void emit("thinking_level_select", { type: "thinking_level_select", level, previousLevel });
	};

	const switchModel = async (model: ModelRef, source: "set" | "cycle") => {
		const previousModel = host.model;
		host.model = model;
		host.entries.push({ type: "model_change", id: `host-${nextEntryId++}`, provider: model.provider, modelId: model.id } as SessionEntry);
		if (options.omp) return;
		changeThinking(HOST_DEFAULT_THINKING);
		if (previousModel.provider === model.provider && previousModel.id === model.id) return;
		await emit("model_select", { type: "model_select", model, previousModel, source });
	};

	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			host.entries.push({ type: "custom", customType, data });
		},
		events: { on: () => () => undefined, emit: () => undefined },
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
			await switchModel(model, "set");
			return true;
		},
		setThinkingLevel: (level: string) => {
			host.thinkingCalls.push(level);
			changeThinking(level);
		},
	};
	if (options.omp) Object.assign(pi, { arktype: () => undefined, pi: {} });
	options.before?.(pi);
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
		 * The user picks a model in the host's own UI (Pi: /model is "set", the
		 * cycle key is "cycle"). Calls Plannotator makes are recorded from here on.
		 */
		userPicks: async (model: ModelRef, source: "set" | "cycle" = "set") => {
			await switchModel(model, source);
			host.modelCalls.length = 0;
			host.thinkingCalls.length = 0;
		},
		/** The user changes only the thinking level (Pi's /thinking or shift+tab). */
		userSetsThinking: (level: string) => changeThinking(level),
		run: (event: string) => emit(event, {}),
	};
}

const SOL = { provider: "openai", id: "gpt-6-sol" };
const LUNA = { provider: "openai", id: "gpt-6-luna" };
const ASTRA = { provider: "openai", id: "gpt-6-astra" };
const NOVA = { provider: "openai", id: "gpt-6-nova" };
const PLAN = "- [ ] Step one\n- [ ] Step two\n";

/** Pi reports a model pick with model_select; oh-my-pi has no such event. */
const HOSTS = [
	{ name: "Pi", omp: false },
	{ name: "oh-my-pi", omp: true },
];

function planWorkspace(projectConfig?: unknown): string {
	const cwd = makeWorkspace(projectConfig);
	writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
	return cwd;
}

function lastState(entries: SessionEntry[]) {
	return entries.filter((entry) => entry.customType === "plannotator").at(-1)?.data as { phase?: string; savedState?: Record<string, unknown> };
}

async function completePlan(runtime: ReturnType<typeof createModelHost>) {
	// The first agent_end after approval only schedules the continuation.
	await runtime.run("agent_end");
	await runtime.markDone(1);
	await runtime.markDone(2);
	await runtime.run("agent_end");
	expect(lastState(runtime.host.entries).phase).toBe("idle");
}

/** Pi's resume: a new runtime on the saved branch, starting on the branch's model and thinking level (sdk.ts). */
function resumeOnPi(first: ReturnType<typeof createModelHost>, cwd: string) {
	return createModelHost({ cwd, initialModel: first.host.model, initialThinking: first.host.thinking, entries: structuredClone(first.host.entries) });
}

function settingsOf(runtime: ReturnType<typeof createModelHost>) {
	return [runtime.host.model, runtime.host.thinking];
}

describe("With nothing picked, plan mode gives back the pre-plan model and thinking level", () => {
	for (const { name, omp } of HOSTS) {
		// Guards: no configured phase settings and no pick leave the model and thinking level where they were.
		test(`${name}: without configured phase settings, approval and completion keep the pre-plan settings`, async () => {
			const cwd = planWorkspace();
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			await runtime.submit();
			expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
			await completePlan(runtime);
			expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
		});

		// Guards: configured settings apply in their phase, Plannotator's own model
		// switches are never taken for a pick, and the pre-plan settings come back.
		test(`${name}: configured phase settings apply in their phase and the pre-plan settings come back at the end`, async () => {
			const cwd = planWorkspace({ phases: { planning: { model: LUNA, thinking: "low" }, executing: { model: ASTRA, thinking: "high" } } });
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			expect(settingsOf(runtime)).toEqual([LUNA, "low"]);
			await runtime.submit();
			expect(settingsOf(runtime)).toEqual([ASTRA, "high"]);
			await completePlan(runtime);
			expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
			expect(runtime.host.entries.some((entry) => (entry.data as { savedState?: { userSelectedModel?: boolean } } | undefined)?.savedState?.userSelectedModel)).toBe(false);
		});

		// Guards: turning plan mode off with nothing picked gives back the pre-plan settings.
		test(`${name}: turning plan mode off gives back the pre-plan settings`, async () => {
			const cwd = makeWorkspace({ phases: { planning: { model: LUNA, thinking: "low" } } });
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			await runtime.command();
			expect(lastState(runtime.host.entries).phase).toBe("idle");
			expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
		});
	}

	// Guards: an external hand-off with nothing picked gives back the pre-plan settings.
	test("Pi: an external hand-off gives back the pre-plan settings", async () => {
		const cwd = planWorkspace({ executionMode: "external", phases: { planning: { model: ASTRA, thinking: "low" } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		expect(settingsOf(runtime)).toEqual([ASTRA, "low"]);
		await runtime.submit();
		expect(lastState(runtime.host.entries).phase).toBe("idle");
		expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
	});

	// Guards: Plannotator's own switch to a configured model the registry resolves
	// to another id (an alias) is not taken for a pick.
	test("Pi: a configured model the registry resolves to another id is not a pick", async () => {
		const cwd = planWorkspace({ phases: { planning: { model: { provider: "openai", id: "gpt-6-luna-latest" } } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: [], registryIds: { "gpt-6-luna-latest": LUNA.id } });
		await runtime.run("session_start");
		await runtime.command();
		expect(runtime.host.model).toEqual(LUNA);
		await runtime.submit();
		expect(runtime.host.model).toEqual(SOL);
	});
});

describe("On Pi, a model the user picks during plan mode is kept (#4111)", () => {
	// Guards: a pick while planning replaces the pre-plan model at approval and at
	// completion; the pre-plan thinking level comes back onto it.
	test("a pick while planning survives approval and completion", async () => {
		const cwd = planWorkspace();
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.userPicks(LUNA);
		await runtime.submit();
		expect(settingsOf(runtime)).toEqual([LUNA, "xhigh"]);
		await completePlan(runtime);
		expect(settingsOf(runtime)).toEqual([LUNA, "xhigh"]);
	});

	// Guards: a pick while executing, here with Pi's cycle key, survives completion.
	test("a pick while executing survives completion", async () => {
		const cwd = planWorkspace();
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.submit();
		await runtime.userPicks(LUNA, "cycle");
		await completePlan(runtime);
		expect(settingsOf(runtime)).toEqual([LUNA, "xhigh"]);
	});

	// Guards: a pick made after a configured planning model replaced it is kept too.
	test("a pick after a configured planning model survives approval and completion", async () => {
		const cwd = planWorkspace({ phases: { planning: { model: LUNA, thinking: "low" } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		expect(runtime.host.model).toEqual(LUNA);
		await runtime.userPicks(ASTRA);
		await runtime.submit();
		expect(settingsOf(runtime)).toEqual([ASTRA, "xhigh"]);
		await completePlan(runtime);
		expect(settingsOf(runtime)).toEqual([ASTRA, "xhigh"]);
	});

	// Guards: turning plan mode off keeps a pick.
	test("turning plan mode off keeps a pick", async () => {
		const cwd = makeWorkspace({ phases: { planning: { thinking: "low" } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.userPicks(LUNA);
		await runtime.command();
		expect(lastState(runtime.host.entries).phase).toBe("idle");
		expect(settingsOf(runtime)).toEqual([LUNA, "xhigh"]);
	});

	// Guards: an approved plan handed off for external execution keeps a pick.
	test("an external hand-off keeps a pick", async () => {
		const cwd = planWorkspace({ executionMode: "external", phases: { planning: { model: ASTRA, thinking: "low" } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.userPicks(LUNA);
		await runtime.submit();
		expect(runtime.host.entries.some((entry) => entry.customType === "plannotator-handoff")).toBe(true);
		expect(lastState(runtime.host.entries).phase).toBe("idle");
		expect(settingsOf(runtime)).toEqual([LUNA, "xhigh"]);
	});

	// Guards: the pick is saved with the plan state, so a resumed planning session
	// keeps it over the configured planning model, and approval keeps it.
	test("a pick while planning survives resume, then approval", async () => {
		const cwd = planWorkspace({ phases: { planning: { model: LUNA, thinking: "low" } } });
		const first = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await first.run("session_start");
		await first.command();
		await first.userPicks(ASTRA);
		const resumed = resumeOnPi(first, cwd);
		await resumed.run("session_start");
		expect(settingsOf(resumed)).toEqual([ASTRA, "low"]);
		await resumed.submit();
		expect(settingsOf(resumed)).toEqual([ASTRA, "xhigh"]);
	});

	// Guards: a pick while executing survives resume (the configured executing model
	// is not re-applied over it) and then completion.
	test("a pick while executing survives resume, then completion", async () => {
		const cwd = planWorkspace({ phases: { executing: { model: ASTRA, thinking: "high" } } });
		const first = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await first.run("session_start");
		await first.command();
		await first.submit();
		expect(settingsOf(first)).toEqual([ASTRA, "high"]);
		await first.userPicks(LUNA);
		const resumed = resumeOnPi(first, cwd);
		await resumed.run("session_start");
		expect(settingsOf(resumed)).toEqual([LUNA, "high"]);
		await completePlan(resumed);
		expect(settingsOf(resumed)).toEqual([LUNA, "xhigh"]);
	});
});

describe("Thinking level is not tracked: it behaves as before picks were kept", () => {
	for (const { name, omp } of HOSTS) {
		// Guards: a thinking level set while planning gives way to phases.executing.thinking
		// at approval and to the pre-plan level at the end.
		test(`${name}: a thinking level set while planning gives way to the configured executing level, then to the pre-plan level`, async () => {
			const cwd = planWorkspace({ phases: { executing: { thinking: "low" } } });
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			runtime.userSetsThinking("high");
			await runtime.submit();
			expect(settingsOf(runtime)).toEqual([SOL, "low"]);
			await completePlan(runtime);
			expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
		});

		// Guards: with no configured executing level, approval gives back the pre-plan level.
		test(`${name}: with no configured executing level, approval gives back the pre-plan level`, async () => {
			const cwd = planWorkspace();
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			runtime.userSetsThinking("high");
			await runtime.submit();
			expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
		});
	}

	// Guards: Pi resets the thinking level when the user picks a model; that reset
	// does not block phases.executing.thinking, and the pre-plan level comes back
	// onto the picked model at the end.
	test("Pi: the thinking reset that comes with a pick does not block the configured executing level", async () => {
		const cwd = planWorkspace({ phases: { executing: { thinking: "low" } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.userPicks(LUNA);
		expect(runtime.host.thinking).toBe(HOST_DEFAULT_THINKING);
		await runtime.submit();
		expect(settingsOf(runtime)).toEqual([LUNA, "low"]);
		await completePlan(runtime);
		expect(settingsOf(runtime)).toEqual([LUNA, "xhigh"]);
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
	// Guards #1722: /tree that stays executing leaves the model and thinking level alone.
	test("a /tree navigation that stays executing keeps a model picked during execution", async () => {
		const cwd = planWorkspace();
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: executingEntries() });
		await runtime.run("session_start");

		await runtime.userPicks(LUNA);
		runtime.userSetsThinking("high");
		// Re-answering an earlier Ask lands on another node of the same
		// executing path.
		await runtime.run("session_tree");

		expect(settingsOf(runtime)).toEqual([LUNA, "high"]);
		expect(runtime.host.modelCalls).toEqual([]);
		expect(runtime.host.thinkingCalls).toEqual([]);
		// Tools are still re-derived from the path.
		expect(runtime.tools.active).toContain("plannotator_mark_done");
	});

	// Guards #1722: nor is the configured executing model re-applied.
	test("a configured executing model is not re-applied over the user's pick either", async () => {
		const cwd = planWorkspace({ phases: { executing: { model: SOL, thinking: "low" } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: executingEntries() });
		await runtime.run("session_start");

		await runtime.userPicks(LUNA);
		runtime.userSetsThinking("high");
		await runtime.run("session_tree");

		expect(runtime.host.model).toEqual(LUNA);
		expect(runtime.host.modelCalls).toEqual([]);
		expect(runtime.host.thinkingCalls).toEqual([]);
	});

	// Guards: /tree into planning restores the branch's saved model and applies the planning model.
	test("a /tree navigation into planning still applies the planning model", async () => {
		const cwd = planWorkspace({ phases: { planning: { model: SOL } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: executingEntries() });
		await runtime.run("session_start");

		await runtime.userPicks(LUNA);
		runtime.host.entries.push({
			type: "custom",
			customType: "plannotator",
			data: { phase: "planning", lastSubmittedPath: "PLAN.md", savedState: { model: SOL, thinkingLevel: "medium" } },
		});
		await runtime.run("session_tree");

		expect(runtime.host.model).toEqual(SOL);
		expect(runtime.host.modelCalls.at(-1)).toEqual(SOL);
	});

	// Guards: on Pi, /tree out of plan mode is a way of leaving it, and keeps a pick.
	test("Pi: a /tree navigation out of plan mode keeps a pick", async () => {
		const cwd = planWorkspace();
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: executingEntries() });
		await runtime.run("session_start");

		await runtime.userPicks(LUNA);
		// A path from before plan mode: no plannotator state at all.
		runtime.host.entries.length = 0;
		await runtime.run("session_tree");

		expect(runtime.host.model).toEqual(LUNA);
	});
});

describe("/tree into another phase applies that phase's settings", () => {
	for (const { name, omp } of HOSTS) {
		// Guards: /tree back to the planning node applies the planning profile, and
		// leaving plan mode restores the pre-plan settings.
		test(`${name}: /tree from execution back to the planning node applies the planning profile, and leaving plan mode restores the pre-plan settings`, async () => {
			const cwd = planWorkspace({ phases: { planning: { model: LUNA, thinking: "low" }, executing: { model: ASTRA, thinking: "high" } } });
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			const planningNode = runtime.host.entries.length;
			await runtime.submit();
			expect(settingsOf(runtime)).toEqual([ASTRA, "high"]);

			// /tree to the planning node: the host keeps the executing model.
			runtime.host.entries.length = planningNode;
			await runtime.run("session_tree");
			expect(lastState(runtime.host.entries).phase).toBe("planning");
			expect(settingsOf(runtime)).toEqual([LUNA, "low"]);

			await runtime.command();
			expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
		});

		// Guards: /tree from after completion back into execution applies the
		// executing profile, and completing on that branch restores the pre-plan settings.
		test(`${name}: /tree from after completion back into execution applies the executing profile`, async () => {
			const cwd = planWorkspace({ phases: { executing: { model: ASTRA, thinking: "high" } } });
			const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [], omp });
			await runtime.run("session_start");
			await runtime.command();
			await runtime.submit();
			const executingPath = runtime.host.entries.slice();
			await completePlan(runtime);
			expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);

			// /tree back into execution: the host keeps the pre-plan model.
			writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
			runtime.host.entries.splice(0, runtime.host.entries.length, ...executingPath);
			await runtime.run("session_tree");
			expect(lastState(runtime.host.entries).phase).toBe("executing");
			expect(settingsOf(runtime)).toEqual([ASTRA, "high"]);

			await completePlan(runtime);
			expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
		});
	}
});

describe("A session saved by 0.29.5 (savedState holds only model and thinkingLevel)", () => {
	for (const { name, omp } of HOSTS) {
		// Guards: an older entry reads safely and completion restores its saved settings.
		test(`${name}: with no pick, completion restores the saved model and thinking level`, async () => {
			const cwd = planWorkspace({ phases: { executing: { model: ASTRA, thinking: "high" } } });
			const runtime = createModelHost({ cwd, initialModel: ASTRA, initialThinking: "high", entries: executingEntries(), omp });
			await runtime.run("session_start");
			await runtime.markDone(1);
			await runtime.markDone(2);
			await runtime.run("agent_end");
			expect(lastState(runtime.host.entries).phase).toBe("idle");
			expect(settingsOf(runtime)).toEqual([SOL, "medium"]);
		});
	}

	// Guards: a pick made after resuming such a session is kept at completion.
	test("Pi: a pick after resuming survives completion", async () => {
		const cwd = planWorkspace({ phases: { executing: { model: ASTRA, thinking: "high" } } });
		const runtime = createModelHost({ cwd, initialModel: ASTRA, initialThinking: "high", entries: executingEntries() });
		await runtime.run("session_start");
		await runtime.userPicks(LUNA);
		await runtime.markDone(1);
		await runtime.markDone(2);
		await runtime.run("agent_end");
		expect(lastState(runtime.host.entries).phase).toBe("idle");
		expect(settingsOf(runtime)).toEqual([LUNA, "medium"]);
	});
});

describe("oh-my-pi reports no model pick, so plan mode there behaves as before picks were kept", () => {
	// Accepted limit, stated in the README: on oh-my-pi a model changed while
	// planning is not kept; approval and completion bring back the pre-plan model.
	test("a model changed while planning is not kept", async () => {
		const cwd = planWorkspace();
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "high", entries: [], omp: true });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.userPicks(LUNA);
		await runtime.submit();
		expect(settingsOf(runtime)).toEqual([SOL, "high"]);
		await completePlan(runtime);
		expect(settingsOf(runtime)).toEqual([SOL, "high"]);
	});

	// Guards: oh-my-pi's /resume emits session_switch before it applies the resumed
	// session's model; the model it then applies is not taken for a pick.
	test("/resume into a planning session with configured phase models", async () => {
		const cwd = planWorkspace({ phases: { planning: { model: LUNA }, executing: { model: ASTRA } } });
		const first = createModelHost({ cwd, initialModel: SOL, entries: [], omp: true });
		await first.run("session_start");
		await first.command();
		expect(first.host.model).toEqual(LUNA);

		const runtime = createModelHost({ cwd, initialModel: NOVA, entries: [], omp: true });
		await runtime.run("session_start");
		runtime.host.entries.splice(0, runtime.host.entries.length, ...structuredClone(first.host.entries));
		await runtime.run("session_switch");
		runtime.host.model = LUNA;
		await runtime.submit();
		expect(runtime.host.model).toEqual(ASTRA);
		await completePlan(runtime);
		expect(runtime.host.model).toEqual(SOL);
	});
});

describe("Another extension's listeners do not change what Plannotator restores", () => {
	// Guards: a thinking listener loaded before Plannotator that writes a session
	// entry of its own changes nothing about approval or completion.
	test("Pi: a thinking listener ahead of Plannotator writes an entry on every change", async () => {
		const cwd = planWorkspace({ phases: { planning: { thinking: "low" }, executing: { thinking: "high" } } });
		const runtime = createModelHost({
			cwd,
			initialModel: SOL,
			initialThinking: "xhigh",
			entries: [],
			before: (api) => api.on("thinking_level_select", () => api.appendEntry("other-extension", { seen: true })),
		});
		await runtime.run("session_start");
		await runtime.command();
		expect(runtime.host.thinking).toBe("low");
		await runtime.submit();
		expect(runtime.host.thinking).toBe("high");
		await completePlan(runtime);
		expect(settingsOf(runtime)).toEqual([SOL, "xhigh"]);
	});
});

// These follow USER_PICK_BEATS_EXECUTING_CONFIG_AT_APPROVAL in index.ts (owner
// decision pending): flipping it fails exactly these tests.
describe("A model picked while planning beats phases.executing.model at approval", () => {
	test("Pi: the pick stays at approval and at completion", async () => {
		const cwd = planWorkspace({ phases: { executing: { model: ASTRA } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.userPicks(LUNA);
		await runtime.submit();
		expect(runtime.host.model).toEqual(LUNA);
		await completePlan(runtime);
		expect(runtime.host.model).toEqual(LUNA);
	});

	test("Pi: also after a configured planning model, while the configured executing thinking still applies", async () => {
		const cwd = planWorkspace({ phases: { planning: { model: LUNA }, executing: { model: SOL, thinking: "low" } } });
		const runtime = createModelHost({ cwd, initialModel: SOL, initialThinking: "xhigh", entries: [] });
		await runtime.run("session_start");
		await runtime.command();
		await runtime.userPicks(ASTRA);
		await runtime.submit();
		expect(settingsOf(runtime)).toEqual([ASTRA, "low"]);
		await completePlan(runtime);
		expect(settingsOf(runtime)).toEqual([ASTRA, "xhigh"]);
	});
});
