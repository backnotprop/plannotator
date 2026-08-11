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
		getActiveTools: () => activeTools,
		lastPersistedState: () => persisted.at(-1),
		run: async (event: string, context: ReturnType<typeof createContext>) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, context);
		},
		setActiveTools: (tools: string[]) => {
			activeTools = [...tools];
		},
	};
}

describe("Plannotator phase tool ownership", () => {
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
		expect(runtime.getActiveTools()).toEqual(["read", "bash", "my_tool"]);
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "executing",
			phaseAddedTools: ["my_tool"],
		});

		await runtime.run("agent_end", context);
		expect(runtime.getActiveTools()).toEqual(["read", "bash"]);
		expect(runtime.lastPersistedState()).toMatchObject({
			phase: "idle",
			phaseAddedTools: [],
		});
	});
});
