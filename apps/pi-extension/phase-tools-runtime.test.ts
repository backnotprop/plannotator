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

/**
 * A host whose model and thinking level are real state: `setModel` changes the
 * model the context reports and every call is recorded, so a test can tell a
 * model Plannotator set apart from one the user picked.
 */
function createModelHost(options: { cwd: string; initialModel: ModelRef; entries: SessionEntry[] }) {
	const handlers = new Map<string, Handler[]>();
	const host = {
		model: options.initialModel,
		thinking: "medium",
		modelCalls: [] as ModelRef[],
		thinkingCalls: [] as string[],
		entries: options.entries,
	};
	const tools = { active: ["read", "bash", "edit", "write"] };

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
		registerCommand: () => undefined,
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerTool: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: (next: string[]) => {
			tools.active = [...next];
		},
		setModel: async (model: ModelRef) => {
			host.modelCalls.push({ provider: model.provider, id: model.id });
			host.model = model;
			return true;
		},
		setThinkingLevel: (level: string) => {
			host.thinkingCalls.push(level);
			host.thinking = level;
		},
	};
	plannotator(pi as never);

	const base = createContext({ cwd: options.cwd, entries: host.entries });
	const context = {
		...base,
		get model() {
			return host.model;
		},
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
	};

	return {
		host,
		tools,
		/** The user picks a model in the host's own UI, not through Plannotator. */
		userPicks: (model: ModelRef, thinking?: string) => {
			host.model = model;
			if (thinking) host.thinking = thinking;
			host.modelCalls.length = 0;
			host.thinkingCalls.length = 0;
		},
		run: async (event: string) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, context as never);
		},
	};
}

const SOL = { provider: "openai", id: "gpt-6-sol" };
const LUNA = { provider: "openai", id: "gpt-6-luna" };
const PLAN = "- [ ] Step one\n- [ ] Step two\n";

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

	test("a /tree navigation out of plan mode still restores the pre-plan model", async () => {
		const cwd = makeWorkspace();
		writeFileSync(join(cwd, "PLAN.md"), PLAN, "utf-8");
		const runtime = createModelHost({ cwd, initialModel: SOL, entries: executingEntries() });
		await runtime.run("session_start");

		runtime.userPicks(LUNA);
		// A path from before plan mode: no plannotator state at all.
		runtime.host.entries.length = 0;
		await runtime.run("session_tree");

		expect(runtime.host.model).toEqual(SOL);
		expect(runtime.host.modelCalls).toEqual([SOL]);
	});
});
