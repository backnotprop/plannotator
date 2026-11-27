/**
 * A model or thinking level the user picks during a plan must survive the
 * plan-approval/completion restore (#4111) — the same rule #1722 established
 * for /tree. The restore only reverts choices Plannotator itself made (or that
 * were already in place at capture time).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";

type Handler = (event: unknown, context: ReturnType<typeof createContext>) => unknown;
type SessionEntry = { type: string; customType?: string; data?: unknown };
type ModelRef = { provider: string; id: string };

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Isolates config lookup so the developer's global plannotator.json is never read. */
function makeWorkspace(projectConfig?: unknown): string {
	const home = makeTempDir("plannotator-model-home-");
	const cwd = makeTempDir("plannotator-model-cwd-");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

	if (projectConfig !== undefined) {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "plannotator.json"), JSON.stringify(projectConfig), "utf-8");
	}

	return cwd;
}

function createContext(options: { cwd?: string; model?: ModelRef } = {}) {
	const entries: SessionEntry[] = [];
	return {
		cwd: options.cwd ?? process.cwd(),
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => true,
		model: options.model,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
		},
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

function createRuntime() {
	const commands = new Map<
		string,
		{ handler: (args: string, context: ReturnType<typeof createContext>) => unknown }
	>();
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Record<string, unknown>>();
	const appliedModels: ModelRef[] = [];
	const thinkingLevels: string[] = [];
	let activeTools: string[] = [];
	let thinkingLevel = "medium";

	const pi = {
		appendEntry: () => undefined,
		events: { on: () => () => undefined },
		getActiveTools: () => [...activeTools],
		getFlag: () => false,
		getThinkingLevel: () => thinkingLevel,
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (
			name: string,
			command: { handler: (args: string, context: ReturnType<typeof createContext>) => unknown },
		) => {
			commands.set(name, command);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerTool: (tool: Record<string, unknown>) => {
			tools.set(tool.name as string, tool);
		},
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: (next: string[]) => {
			activeTools = [...next];
		},
		setModel: async (model: ModelRef) => {
			appliedModels.push({ provider: model.provider, id: model.id });
			return true;
		},
		setThinkingLevel: (level: string) => {
			thinkingLevel = level;
			thinkingLevels.push(level);
		},
	};

	plannotator(pi as never);

	return {
		commands,
		appliedModels,
		thinkingLevels,
		tools,
		getThinkingLevel: () => thinkingLevel,
		/** Simulates a model/thinking change the extension did not make. */
		userSetThinkingLevel: (level: string) => {
			thinkingLevel = level;
		},
		run: async (event: string, context: ReturnType<typeof createContext>) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, context);
		},
	};
}

async function togglePlanMode(
	runtime: ReturnType<typeof createRuntime>,
	context: ReturnType<typeof createContext>,
): Promise<void> {
	await runtime.run("session_start", context);
	await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
}

describe("model and thinking level survival across plan phases", () => {
	test("a model the user changed during planning is not reverted on exit", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd, model: { provider: "provider-a", id: "model-a" } });
		await togglePlanMode(runtime, context);

		context.model = { provider: "provider-b", id: "model-b" };
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		expect(runtime.appliedModels).not.toContainEqual({ provider: "provider-a", id: "model-a" });
	});

	test("the pre-plan model is restored when the user did not change it", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd, model: { provider: "provider-a", id: "model-a" } });
		await togglePlanMode(runtime, context);

		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		expect(runtime.appliedModels).toContainEqual({ provider: "provider-a", id: "model-a" });
	});

	test("a configured phase model is still restored after the phase ends", async () => {
		const cwd = makeWorkspace({
			phases: { planning: { model: { provider: "phase-provider", id: "phase-model" } } },
		});
		const runtime = createRuntime();
		const context = createContext({ cwd, model: { provider: "user-provider", id: "user-model" } });
		await togglePlanMode(runtime, context);

		// Entering planning applied the configured model; leaving restores the
		// user model because the phase change, not the user, moved it.
		expect(runtime.appliedModels).toContainEqual({
			provider: "phase-provider",
			id: "phase-model",
		});
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);
		expect(runtime.appliedModels).toContainEqual({ provider: "user-provider", id: "user-model" });
	});

	test("a thinking level the user changed during planning is not reverted on exit", async () => {
		const cwd = makeWorkspace();
		const runtime = createRuntime();
		const context = createContext({ cwd, model: { provider: "provider-a", id: "model-a" } });
		await togglePlanMode(runtime, context);

		runtime.userSetThinkingLevel("high");
		await runtime.commands.get("plannotator-plan-mode")?.handler("", context);

		expect(runtime.getThinkingLevel()).toBe("high");
	});
});
