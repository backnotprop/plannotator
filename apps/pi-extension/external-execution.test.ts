import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";
import { PLANNOTATOR_PLAN_APPROVED_CHANNEL } from "./plannotator-events.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Minimal Pi host stub: enough surface for a `--plan` session to boot, submit a
 * plan, and finish a turn, while recording every side effect the extension is
 * expected to produce (events, session entries, tool scope, model, thinking).
 */
function createHarness(cwd: string) {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const sentUserMessages: unknown[] = [];
	const state = {
		activeTools: ["read", "bash", "edit", "write"],
		thinkingLevel: "medium",
		selectedModel: { provider: "test", id: "original-model" },
	};

	const pi = {
		events: {
			on: () => undefined,
			emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }),
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
		getFlag: () => true,
		getActiveTools: () => [...state.activeTools],
		setActiveTools: (tools: string[]) => { state.activeTools = [...tools]; },
		getThinkingLevel: () => state.thinkingLevel,
		setThinkingLevel: (level: string) => { state.thinkingLevel = level; },
		setModel: async (model: { provider: string; id: string }) => {
			state.selectedModel = model;
			return true;
		},
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		sendMessage: () => undefined,
		sendUserMessage: (message: unknown) => sentUserMessages.push(message),
	};

	const ctx = {
		cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => true,
		model: { provider: "test", id: "original-model" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "test-session",
			getSessionFile: () => null,
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
		pi,
		ctx,
		commands,
		tools,
		handlers,
		emitted,
		entries,
		sentUserMessages,
		state,
		async startSession(): Promise<void> {
			plannotator(pi as never);
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx);
			}
		},
		submitPlan(filePath: string) {
			return tools.get("plannotator_submit_plan")!.execute("call-1", { filePath }, undefined, undefined, ctx);
		},
		async endAgentTurn(): Promise<void> {
			for (const handler of handlers.get("agent_end") ?? []) {
				await handler({ messages: [] }, ctx);
			}
			// The automatic-execution continuation is scheduled on a macrotask.
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}

function writePlannotatorConfig(cwd: string, config: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "plannotator.json"), JSON.stringify(config));
}

const PLAN_CONTENT = "# Plan\n\n- [ ] Implement the change\n";

describe("external plan execution", () => {
	test("hands off an approved --plan session and restores its original state", async () => {
		const cwd = makeTempDir("plannotator-external-execution-");
		writePlannotatorConfig(cwd, {
			executionMode: "external",
			phases: {
				planning: {
					model: { provider: "test", id: "planning-model" },
					thinking: "high",
				},
			},
		});
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		const result = await harness.submitPlan("PLAN.md") as {
			details: { approved: boolean; handedOff?: boolean };
			terminate?: boolean;
		};

		expect(result.details).toEqual({ approved: true, handedOff: true });
		expect(result.terminate).toBe(true);
		expect(harness.emitted).toContainEqual({
			channel: PLANNOTATOR_PLAN_APPROVED_CHANNEL,
			payload: {
				cwd,
				planFilePath: "PLAN.md",
				planContent: PLAN_CONTENT,
			},
		});
		await harness.endAgentTurn();
		expect(harness.entries.some((entry) => entry.type === "plannotator-execute")).toBe(false);
		expect(harness.entries).toContainEqual({ type: "plannotator-handoff", data: { planFilePath: "PLAN.md" } });
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.state.activeTools).toEqual(["read", "bash", "edit", "write"]);
		expect(harness.state.thinkingLevel).toBe("medium");
		expect(harness.state.selectedModel).toEqual({ provider: "test", id: "original-model" });
	});

	test("executes in-session and emits no handoff when executionMode is unset", async () => {
		const cwd = makeTempDir("plannotator-automatic-execution-");
		writePlannotatorConfig(cwd, {
			phases: {
				planning: {
					model: { provider: "test", id: "planning-model" },
					thinking: "high",
				},
			},
		});
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		const result = await harness.submitPlan("PLAN.md") as {
			details: { approved: boolean; handedOff?: boolean };
			terminate?: boolean;
		};

		expect(result.details).toEqual({ approved: true });
		expect(result.terminate).toBe(true);
		expect(harness.emitted.some((event) => event.channel === PLANNOTATOR_PLAN_APPROVED_CHANNEL)).toBe(false);
		expect(harness.entries).toContainEqual({ type: "plannotator-execute", data: { lastSubmittedPath: "PLAN.md" } });
		expect(harness.entries.some((entry) => entry.type === "plannotator-handoff")).toBe(false);

		const persisted = harness.entries.filter((entry) => entry.type === "plannotator");
		expect((persisted.at(-1)?.data as { phase?: string })?.phase).toBe("executing");

		await harness.endAgentTurn();
		expect(harness.sentUserMessages).toEqual(["Continue with the approved plan."]);
	});
});
